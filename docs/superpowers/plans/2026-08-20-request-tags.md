# Request Tags (`x-babellm-tags`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller label a request with `key=value` pairs via an `x-babellm-tags` header, store them on the request log, and filter `/logs` by any number of pairs.

**Architecture:** A pure parser in `src/lib/tags.ts` defines the one set of rules. The gateway wraps it to throw a `400`; the admin filter wraps it to drop bad input. Tags land in a nullable `jsonb` column on the partitioned `request_logs` table and are queried with a single `@>` containment operator.

**Tech Stack:** Next.js 16 (App Router), React 19, Drizzle ORM, Postgres 15+, Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-20-request-tags-design.md`

## Global Constraints

- **Never point tests at port 5432.** That is the developer's own database. This worktree's `.env.test` already names `postgres://babellm:babellm@localhost:5434/babellm_test_tags`. Do not edit it, and never run `pnpm test:db:down` — it destroys the test containers for every worktree at once.
- The test Postgres on 5434 is **already running**. If `pnpm test` cannot connect, run `pnpm test:db:up` — never `down` first.
- **Run `pnpm test` from the worktree root**, `/Users/slz/Code/slz/babellm-gateway/.claude/worktrees/request-tags`.
- **`src/lib/tags.ts` must import nothing.** It is bundled into the browser via the logs filter bar. It must never import `server-only`, `@/lib/db`, or anything under `@/lib/gateway/`.
- Header contract, exact values, from spec §4: max **2048 UTF-8 bytes** raw; max **16** pairs; key `^[a-z0-9_.-]{1,64}$` after lowercasing; value **1–256** characters after trimming, no control characters, no `,`; duplicate keys rejected after lowercasing. Checked in that order.
- Error code for every tag rejection is `invalid_tags`, type `invalid_request_error`, status `400`.
- **`NULL` is the only "no tags" value.** Never write `{}`.
- Values keep their case. Keys are lowercased.
- The repo runs ESLint with `eslint-config-next`; run `pnpm lint` and `pnpm typecheck` before the final commit of each task that touches TypeScript.
- Commit messages end with the trailer block used throughout this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Gahkm4uJr4MHKmekGGjBc3
  ```

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/tags.ts` | **Create.** Pure parser and the header name. Zero imports. |
| `tests/lib/tags.test.ts` | **Create.** Every accept and reject case. |
| `src/lib/gateway/tags.ts` | **Create.** Reads the header off a `Request`, throws `GatewayError`. |
| `src/lib/db/schema.ts` | **Modify.** Add `tags` to `requestLogs`. |
| `drizzle/00NN_*.sql` | **Create** (generated). `ALTER TABLE … ADD COLUMN "tags" jsonb;` |
| `src/lib/logs/types.ts` | **Modify.** `tags` on `RequestLogEntry`, `LogRow`, `LogDetail`; `tags` on `LogFilter`. |
| `src/lib/logs/postgres.ts` | **Modify.** Write, select, and filter the column. |
| `src/lib/gateway/handler.ts` | **Modify.** Parse after auth, thread onto the log row. |
| `src/lib/admin/logs.ts` | **Modify.** `tag` search param → `LogFilter.tags`. |
| `src/lib/admin/log-filter-params.ts` | **Modify.** `addTagParam` / `removeTagParam`. |
| `src/app/(admin)/logs/log-filters.tsx` | **Modify.** Tag inputs and chips. |
| `src/app/(admin)/logs/[id]/page.tsx` | **Modify.** Render tags. |
| `tests/helpers/gateway.ts` | **Modify.** Optional headers on request builders. |
| `README.md` | **Modify.** Document the header. |

---

## Task 1: The pure tag parser

**Files:**
- Create: `src/lib/tags.ts`
- Test: `tests/lib/tags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const TAGS_HEADER = 'x-babellm-tags'`
  - `export type TagParse = { ok: true; tags: Record<string, string> | null } | { ok: false; message: string }`
  - `export function parseTags(raw: string | null | undefined): TagParse`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/tags.test.ts`:

```ts
import { expect, test } from 'vitest'
import { TAGS_HEADER, parseTags } from '@/lib/tags'

/** Unwraps a parse expected to succeed, so a failure shows its message
 * instead of a bare `undefined` mismatch. */
function ok(raw: string | null | undefined) {
  const result = parseTags(raw)
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.message}`)
  return result.tags
}

function err(raw: string) {
  const result = parseTags(raw)
  if (result.ok) throw new Error('expected a failed parse')
  return result.message
}

test('the header name is the one the gateway documents', () => {
  expect(TAGS_HEADER).toBe('x-babellm-tags')
})

test('parses comma-separated key=value pairs', () => {
  expect(ok('env=prod,feature=checkout')).toEqual({ env: 'prod', feature: 'checkout' })
})

test('trims whitespace around both sides of a pair', () => {
  expect(ok('  env = prod ,  team =a ')).toEqual({ env: 'prod', team: 'a' })
})

test('lowercases keys but preserves value case', () => {
  expect(ok('ENV=Prod')).toEqual({ env: 'Prod' })
})

test('splits on the first = only, so a value may contain one', () => {
  expect(ok('note=a=b')).toEqual({ note: 'a=b' })
})

// null is "no tags", not an error, and must be distinguishable from {} —
// the write path stores null and never {}, so the two cannot be conflated.
test.each([
  ['absent', null],
  ['undefined', undefined],
  ['empty', ''],
  ['whitespace only', '   '],
])('a %s header parses as no tags at all', (_label, raw) => {
  expect(ok(raw)).toBeNull()
})

test('accepts every character the key charset allows', () => {
  expect(ok('a_b.c-d9=x')).toEqual({ 'a_b.c-d9': 'x' })
})

test('accepts exactly 16 pairs', () => {
  const raw = Array.from({ length: 16 }, (_, i) => `k${i}=v`).join(',')
  expect(Object.keys(ok(raw) ?? {})).toHaveLength(16)
})

test('rejects a 17th pair and says how many it got', () => {
  const raw = Array.from({ length: 17 }, (_, i) => `k${i}=v`).join(',')
  expect(err(raw)).toBe('x-babellm-tags: at most 16 tags, got 17')
})

test('rejects a header over 2048 bytes before counting pairs', () => {
  // One pair, so the pair count is legal — only the size rule can reject it.
  const raw = `k=${'v'.repeat(3000)}`
  expect(err(raw)).toBe('x-babellm-tags: header is at most 2048 bytes, got 3002')
})

test('measures the size limit in utf-8 bytes, not characters', () => {
  // 'é' is two bytes: 1025 of them is 2050 bytes but only 1027 characters.
  const raw = `k=${'é'.repeat(1025)}`
  expect(err(raw)).toContain('at most 2048 bytes')
})

test('rejects a token with no =', () => {
  expect(err('env=prod,justalabel')).toBe(
    'x-babellm-tags: "justalabel" is not a key=value pair',
  )
})

test('rejects a key outside the allowed charset', () => {
  expect(err('team name=a')).toBe(
    'x-babellm-tags: key "team name" is not a valid tag key',
  )
})

test('rejects an empty key', () => {
  expect(err('=prod')).toBe('x-babellm-tags: key "" is not a valid tag key')
})

test('rejects a key over 64 characters', () => {
  const key = 'k'.repeat(65)
  expect(err(`${key}=v`)).toBe(`x-babellm-tags: key "${key}" is not a valid tag key`)
})

test('rejects an empty value', () => {
  expect(err('env=')).toBe('x-babellm-tags: tag "env" has an empty value')
})

test('rejects a value over 256 characters', () => {
  expect(err(`env=${'v'.repeat(257)}`)).toBe(
    'x-babellm-tags: value for "env" is at most 256 characters, got 257',
  )
})

test('rejects a control character in a value', () => {
  expect(err('env=pr\u0007od')).toBe(
    'x-babellm-tags: value for "env" contains a control character',
  )
})

test('rejects DEL as a control character too', () => {
  expect(err('env=pr\u007fod')).toBe(
    'x-babellm-tags: value for "env" contains a control character',
  )
})

// Trimming runs before the control check, so a value that is only whitespace
// is an empty value rather than a control-character rejection.
test('a tab-only value is an empty value, not a control character', () => {
  expect(err('env=\t')).toBe('x-babellm-tags: tag "env" has an empty value')
})

test('rejects a duplicate key, after lowercasing', () => {
  expect(err('env=prod,ENV=staging')).toBe('x-babellm-tags: duplicate key "env"')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/tags.test.ts`
Expected: FAIL — every test errors on the missing module `@/lib/tags`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tags.ts`:

```ts
/**
 * The `x-babellm-tags` header: caller-supplied `key=value` pairs recorded on
 * the request log.
 *
 * This module imports nothing, deliberately. It is the shared vocabulary
 * between the gateway ingress and the `/logs` filter bar, and the filter bar
 * is a Client Component — so anything imported here enters the browser
 * bundle. The throwing wrapper lives in `@/lib/gateway/tags` instead, because
 * `GatewayError` pulls in the OpenAI SDK. Same reasoning as
 * `@/lib/admin/log-filter-params`.
 */

export const TAGS_HEADER = 'x-babellm-tags'

/** Raw header bytes, not characters: a header is a byte budget, and counting
 * characters would let a multi-byte value smuggle in twice the size. */
const MAX_BYTES = 2048
const MAX_TAGS = 16
const MAX_VALUE_LENGTH = 256

const KEY_RE = /^[a-z0-9_.-]{1,64}$/
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * A result rather than an exception, because the two callers disagree about
 * what a bad tag means. The gateway turns a failure into a 400; the admin
 * filter drops it and shows the default view, per parseLogFilter's
 * "a hand-edited URL should show a view, not an error page" contract.
 */
export type TagParse =
  | { ok: true; tags: Record<string, string> | null }
  | { ok: false; message: string }

function fail(message: string): TagParse {
  return { ok: false, message: `${TAGS_HEADER}: ${message}` }
}

/**
 * Parses a raw `x-babellm-tags` value.
 *
 * Absent, empty, or whitespace-only all yield `tags: null` — "no tags sent" —
 * never `{}`. The write path stores that `null` as SQL NULL, which is what
 * keeps "sent no tags" distinguishable from a row written before this feature
 * existed.
 */
export function parseTags(raw: string | null | undefined): TagParse {
  if (raw == null) return { ok: true, tags: null }

  // Size first, so an abusive header is rejected before anything iterates it.
  const bytes = new TextEncoder().encode(raw).length
  if (bytes > MAX_BYTES) {
    return fail(`header is at most ${MAX_BYTES} bytes, got ${bytes}`)
  }

  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, tags: null }

  const tokens = trimmed.split(',')
  if (tokens.length > MAX_TAGS) {
    return fail(`at most ${MAX_TAGS} tags, got ${tokens.length}`)
  }

  const tags: Record<string, string> = {}
  for (const token of tokens) {
    // The first `=` only: the key charset excludes `=`, so `note=a=b` is
    // unambiguously the key `note` with the value `a=b`, and no escaping
    // rule is needed.
    const split = token.indexOf('=')
    if (split === -1) return fail(`"${token.trim()}" is not a key=value pair`)

    const key = token.slice(0, split).trim().toLowerCase()
    const value = token.slice(split + 1).trim()

    if (!KEY_RE.test(key)) return fail(`key "${key}" is not a valid tag key`)
    if (value === '') return fail(`tag "${key}" has an empty value`)
    if (value.length > MAX_VALUE_LENGTH) {
      return fail(
        `value for "${key}" is at most ${MAX_VALUE_LENGTH} characters, got ${value.length}`,
      )
    }
    if (CONTROL_RE.test(value)) {
      return fail(`value for "${key}" contains a control character`)
    }
    // After lowercasing, so `env` and `ENV` collide as the caller intended
    // them to. Rejecting beats last-wins: silently dropping half of an
    // ambiguous header is the failure mode this whole feature refuses.
    if (Object.hasOwn(tags, key)) return fail(`duplicate key "${key}"`)

    tags[key] = value
  }

  return { ok: true, tags }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/tags.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tags.ts tests/lib/tags.test.ts
git commit -m "feat(tags): parse the x-babellm-tags header

A pure, import-free parser so the gateway ingress and the /logs filter bar
share one set of rules. Returns a result rather than throwing, because the
two callers disagree about what a bad tag means."
```

---

## Task 2: Persist tags on the request log

**Files:**
- Modify: `src/lib/db/schema.ts` (the `requestLogs` table)
- Create: `drizzle/00NN_*.sql` (generated by drizzle-kit; do not hand-write the name)
- Modify: `src/lib/logs/types.ts` (`RequestLogEntry`, `LogRow`, `LogDetail`)
- Modify: `src/lib/logs/postgres.ts` (`write`, `LIST_COLUMNS`, `get`)
- Test: `tests/lib/logs/postgres-store.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `requestLogs.tags` — Drizzle column, type `Record<string, string> | null`
  - `RequestLogEntry.tags?: Record<string, string> | null`
  - `LogRow.tags: Record<string, string> | null` and, by extension, `LogDetail.tags`

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/logs/postgres-store.test.ts`. That file already defines an
`entry(overrides)` helper at the top which fills in every required field — use
it rather than writing entry literals.

```ts
test('a written tag set comes back on the row and on the detail', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, tags: { env: 'prod', team: 'a' } }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'a' })

  const detail = await postgresStore.get(id)
  expect(detail?.tags).toEqual({ env: 'prod', team: 'a' })
})

// The distinction this column exists to preserve: a request that sent no
// header must be NULL, never {}, so it stays distinguishable from a row
// written before the feature existed.
test('an entry with no tags stores SQL NULL, not an empty object', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toBeNull()

  const [row] = await db
    .select({ isNull: sql<boolean>`${requestLogs.tags} IS NULL` })
    .from(requestLogs)
    .where(eq(requestLogs.id, id))
  expect(row.isNull).toBe(true)
})

test('an empty tag object is stored as NULL rather than {}', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, tags: {} }))

  const [row] = await db
    .select({ isNull: sql<boolean>`${requestLogs.tags} IS NULL` })
    .from(requestLogs)
    .where(eq(requestLogs.id, id))
  expect(row.isNull).toBe(true)
})
```

The file already imports `db`, `requestLogs`, `postgresStore`, and `uuidv7`. Add
`eq` and `sql`:

```ts
import { eq, sql } from 'drizzle-orm'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: FAIL — `tags` is not a known property of the entry type, and the column does not exist.

- [ ] **Step 3: Add the column to the schema**

In `src/lib/db/schema.ts`, inside the `requestLogs` table definition, directly after the `droppedParams` line:

```ts
    // Caller-supplied key=value pairs from the x-babellm-tags header.
    // Nullable with no default, and never written as {}: NULL means "this
    // request sent no tags", which must stay distinguishable from a row
    // written before this column existed. Unindexed by decision — every
    // /logs query is already bounded by the uuid v7 keyset range, so a
    // containment filter scans a bounded slice rather than the table.
    tags: jsonb('tags').$type<Record<string, string> | null>(),
```

`jsonb` is already imported at the top of the file.

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate`

Expected: a new `drizzle/00NN_<name>.sql` containing exactly
`ALTER TABLE "request_logs" ADD COLUMN "tags" jsonb;`.

Open the generated file and confirm that is all it contains. If drizzle-kit
emitted anything that drops or recreates `request_logs`, **stop and report it**
— that table is partitioned and hand-tuned in `drizzle/0003_broad_queen_noir.sql`,
and recreating it would lose the `PARTITION BY RANGE ("id")` clause.

The test suite's global setup applies migrations, so no manual migrate step is
needed for tests.

- [ ] **Step 5: Add `tags` to the log types**

In `src/lib/logs/types.ts`:

In `RequestLogEntry`, after the `droppedParams?: string[]` line:

```ts
  /** Caller-supplied tags from the x-babellm-tags header. Absent or null both
   * mean "no tags"; the store writes SQL NULL for either. */
  tags?: Record<string, string> | null
```

In `LogRow`, after `costUsd: string | null`:

```ts
  tags: Record<string, string> | null
```

`LogDetail extends LogRow`, so it inherits it — do not add it twice.

- [ ] **Step 6: Read and write the column in the store**

In `src/lib/logs/postgres.ts`:

Add to `LIST_COLUMNS`, after `costUsd`:

```ts
  tags: requestLogs.tags,
```

In `write()`, after the `droppedParams` line:

```ts
      // An empty object is normalized to NULL here rather than at the call
      // site, so no caller can accidentally introduce the {} state the
      // column's comment forbids.
      tags: entry.tags && Object.keys(entry.tags).length > 0 ? entry.tags : null,
```

In `get()`, in the returned object after `costUsd: log.costUsd,`:

```ts
      tags: log.tags,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS. Existing tests that build a `LogRow` literal may now fail to
typecheck because `tags` is required on it; add `tags: null` to those literals.

- [ ] **Step 9: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/db/schema.ts drizzle src/lib/logs/types.ts src/lib/logs/postgres.ts tests/lib/logs/postgres-store.test.ts
git commit -m "feat(logs): record request tags on request_logs

A nullable jsonb column, propagated to every existing partition by the
ALTER on the partitioned parent. An empty object normalizes to NULL, so
'sent no tags' stays distinguishable from a pre-migration row."
```

---

## Task 3: Read the header on the gateway path

**Files:**
- Create: `src/lib/gateway/tags.ts`
- Modify: `src/lib/gateway/handler.ts`
- Modify: `tests/helpers/gateway.ts` (`chatRequest`, `responsesRequest`)
- Test: `tests/gateway/tags.test.ts`

**Interfaces:**
- Consumes: `parseTags`, `TAGS_HEADER` from Task 1; `RequestLogEntry.tags` from Task 2.
- Produces:
  - `export function tagsFromRequest(request: Request): Record<string, string> | null`
  - `chatRequest(body, apiKey, headers?)` and `responsesRequest(body, apiKey, headers?)`

- [ ] **Step 1: Add optional headers to the test request builders**

In `tests/helpers/gateway.ts`, change both builders to accept extra headers:

```ts
export function chatRequest(
  body: unknown,
  apiKey: string | null,
  headers: Record<string, string> = {},
) {
  return new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export function responsesRequest(
  body: unknown,
  apiKey: string | null,
  headers: Record<string, string> = {},
) {
  return new Request('http://gateway.test/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}
```

The parameter is optional, so every existing call site keeps working.

- [ ] **Step 2: Write the failing test**

Create `tests/gateway/tags.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { handleResponses } from '@/lib/gateway/responses-handler'
import {
  chatRequest, fakeAdapterByProvider, fakeAdapterDeps, responsesRequest, seedGateway, seedTargets,
} from '../helpers/gateway'
import { waitForLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

test('a valid header lands on the log row', async () => {
  const { apiKey } = await seedGateway()

  const response = await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod,feature=checkout' }),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  expect(response.status).toBe(200)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod', feature: 'checkout' })
})

test('no header means a null tags column, not an empty object', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toBeNull()
})

test('a malformed header is a 400 that never reaches the provider', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const response = await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod,ENV=staging' }),
    fakeAdapterDeps({ chat }),
  )

  expect(response.status).toBe(400)
  const payload = await response.json()
  expect(payload.error.code).toBe('invalid_tags')
  expect(payload.error.message).toBe('x-babellm-tags: duplicate key "env"')
  expect(chat).not.toHaveBeenCalled()
})

// The rejection has to be attributable, which is the whole reason validation
// runs after resolveApiKey rather than before it.
test('a rejected header still writes a log row against the calling key', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'not a pair' }),
    fakeAdapterDeps({ chat: vi.fn() }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0]).toMatchObject({ status: 400, outcome: 'error', keyName: 'test key' })

  const detail = await postgresStore.get(page.rows[0].id)
  expect(detail?.errorCode).toBe('invalid_tags')
})

// Tags are most useful on requests that went wrong, so they must not be
// conditional on the request going right. This is what the ordering in the
// handler buys, and it is the test that would fail if someone moved the
// parse below the body parse or the routing.
test('tags reach the log row when the upstream call fails', async () => {
  const { apiKey } = await seedGateway()
  const boom = new OpenAI.APIError(500, { message: 'boom', code: 'x' }, 'boom', undefined)

  await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod' }),
    fakeAdapterDeps({ chat: vi.fn().mockRejectedValue(boom) }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].status).toBeGreaterThanOrEqual(500)
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

test('tags reach the log row when the body fails to parse', async () => {
  const { apiKey } = await seedGateway()

  const response = await handleChatCompletions(
    chatRequest({ messages: [] }, apiKey, { 'x-babellm-tags': 'env=prod' }),
    fakeAdapterDeps({ chat: vi.fn() }),
  )
  expect(response.status).toBe(400)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

// Both ingresses run through runGatewayRequest, so the header is read once
// for both. This is the test that fails if someone moves the parse into the
// chat ingress instead of the shared lifecycle.
test('the responses ingress reads the same header', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi' },
      apiKey,
      { 'x-babellm-tags': 'env=prod' },
    ),
    fakeAdapterByProvider({
      p1: { respond: vi.fn().mockResolvedValue(upstreamResponse) },
    }),
  )

  expect(res.status).toBe(200)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

test('the responses ingress rejects a malformed header too', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi' },
      apiKey,
      { 'x-babellm-tags': 'env=prod,ENV=staging' },
    ),
    fakeAdapterByProvider({ p1: { respond: vi.fn() } }),
  )

  expect(res.status).toBe(400)
  const payload = await res.json()
  expect(payload.error.code).toBe('invalid_tags')
})
```

Those last two need extra imports and one more fixture at the top of the file —
the shapes are taken from `tests/gateway/responses-ingress.test.ts`:

```ts
import { handleResponses } from '@/lib/gateway/responses-handler'
import {
  chatRequest, fakeAdapterByProvider, fakeAdapterDeps, responsesRequest, seedGateway, seedTargets,
} from '../helpers/gateway'

const upstreamResponse = {
  id: 'resp_upstream', object: 'response', created_at: 1, model: 'up-model',
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
}
```

`responses-ingress.test.ts` also stubs `console.log` in its `beforeEach`
(`vi.spyOn(console, 'log').mockImplementation(() => {})`). Add that to this
file's `beforeEach` if the Responses tests turn out to be noisy.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/gateway/tags.test.ts`
Expected: FAIL — tags are `null` on every row and the malformed header returns `200`.

- [ ] **Step 4: Write the gateway wrapper**

Create `src/lib/gateway/tags.ts`:

```ts
import 'server-only'
import { TAGS_HEADER, parseTags } from '@/lib/tags'
import { GatewayError } from './errors'

/**
 * Reads and validates `x-babellm-tags` off an inbound request.
 *
 * Throws rather than degrading, unlike the admin filter's use of the same
 * parser: a caller who typos a tag and is not told gets a dashboard quietly
 * missing a slice of its traffic, undetectable from either side. A 400 in
 * development costs a minute; a silently short count costs the trust in every
 * count on the page.
 *
 * A repeated header line needs no handling here — Headers.get() joins repeats
 * with ", ", which is already the pair separator.
 */
export function tagsFromRequest(request: Request): Record<string, string> | null {
  const result = parseTags(request.headers.get(TAGS_HEADER))
  if (!result.ok) {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_tags',
      message: result.message,
    })
  }
  return result.tags
}
```

- [ ] **Step 5: Wire it into the handler**

In `src/lib/gateway/handler.ts`:

Add the import beside the other local imports:

```ts
import { tagsFromRequest } from './tags'
```

Declare the binding with the other values tracked outside the `try`, after
`let dropped: string[] = []`:

```ts
  // Parsed before anything else can fail, so a request that dies in body
  // parsing, routing, or upstream still carries its tags on the log row.
  let tags: Record<string, string> | null = null
```

Inside `writeLog`, in the `logRequest({ … })` call, after the `droppedParams`
spread line:

```ts
      tags,
```

In the `try` block, immediately after `capturePayloads = apiKey.logPayloads`
and **before** `const body = ingress.parse(await readJson(request))`:

```ts
    // After resolveApiKey so the rejection is attributable — the catch below
    // logs any GatewayError thrown in here, and reads keyId/keyName from this
    // scope. Before the body parse because it is the cheaper check, and
    // because it puts the tags in scope for every failure path after it.
    tags = tagsFromRequest(request)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gateway/tags.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite, then lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/gateway/tags.ts src/lib/gateway/handler.ts tests/helpers/gateway.ts tests/gateway/tags.test.ts
git commit -m "feat(gateway): accept x-babellm-tags on every ingress

Parsed after the api key resolves, so a rejection is attributable and the
existing catch logs it, and before the body parses, so a request that fails
anywhere downstream still carries its tags."
```

---

## Task 4: Filter the store by tags

**Files:**
- Modify: `src/lib/logs/types.ts` (`LogFilter`)
- Modify: `src/lib/logs/postgres.ts` (`conditions`)
- Test: `tests/lib/logs/postgres-store.test.ts`

**Interfaces:**
- Consumes: `requestLogs.tags` from Task 2.
- Produces: `LogFilter.tags?: Record<string, string>`

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/logs/postgres-store.test.ts`:

```ts
/** Four rows whose tags differ, for the containment cases below. Uses the
 * `entry()` helper already defined at the top of this file. */
async function seedTagged() {
  const tagSets: Array<Record<string, string> | null> = [
    { env: 'prod', team: 'a' },
    { env: 'prod', team: 'b' },
    { env: 'staging', team: 'a' },
    null,
  ]
  for (const tags of tagSets) {
    await postgresStore.write(entry({ tags }))
  }
}

test('one pair matches every row carrying it', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod' } })
  expect(page.rows).toHaveLength(2)
})

test('two pairs are ANDed, not ORed', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod', team: 'a' } })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'a' })
})

test('a row matches a filter naming only some of its tags', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { team: 'b' } })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'b' })
})

// A NULL column yields NULL under @>, not true — so an untagged row, and
// every row written before this column existed, is excluded rather than
// matching an empty set.
test('an untagged row matches no tag filter', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod' } })
  expect(page.rows.every((row) => row.tags !== null)).toBe(true)
})

test('a tag filter combines with the other filters', async () => {
  await seedTagged()
  const page = await postgresStore.query({
    limit: 10,
    tags: { env: 'prod' },
    statusClass: 'success',
  })
  expect(page.rows).toHaveLength(2)
})

test('a value containing SQL syntax is parameterized, not interpolated', async () => {
  await seedTagged()
  const page = await postgresStore.query({
    limit: 10,
    tags: { env: "prod' OR 1=1 --" },
  })
  expect(page.rows).toHaveLength(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: FAIL — `tags` is not a known property of `LogFilter`, and once forced through, every query returns all rows because the filter is ignored.

- [ ] **Step 3: Add the filter field**

In `src/lib/logs/types.ts`, inside `LogFilter`, after `outcome?: RequestOutcome`:

```ts
  /** Every pair must be present on the row: one jsonb containment operator,
   * ANDed regardless of how many pairs are supplied. */
  tags?: Record<string, string>
```

- [ ] **Step 4: Add the condition**

In `src/lib/logs/postgres.ts`, inside `conditions()`, after the `filter.outcome` line:

```ts
  // Containment: `@>` is true when the row's tags contain every pair given,
  // so N pairs are ANDed in one operator. NULL tags yield NULL, which is
  // false enough to exclude untagged and pre-migration rows.
  if (filter.tags && Object.keys(filter.tags).length > 0) {
    where.push(sql`${requestLogs.tags} @> ${JSON.stringify(filter.tags)}::jsonb`)
  }
```

`sql` is already imported in this file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, then lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logs/types.ts src/lib/logs/postgres.ts tests/lib/logs/postgres-store.test.ts
git commit -m "feat(logs): filter request logs by tag containment

One jsonb @> operator ANDs every supplied pair. A NULL tags column yields
NULL, so untagged and pre-migration rows match no tag filter."
```

---

## Task 5: Turn `tag` URL params into a filter

**Files:**
- Modify: `src/lib/admin/logs.ts` (`LogSearchParams`, `parseLogFilter`)
- Modify: `src/lib/admin/log-filter-params.ts` (`addTagParam`, `removeTagParam`)
- Test: `tests/lib/admin/logs.test.ts`, `tests/lib/admin/log-filter-params.test.ts`

**Interfaces:**
- Consumes: `parseTags` from Task 1; `LogFilter.tags` from Task 4.
- Produces:
  - `LogSearchParams.tag?: string | string[]`
  - `export function addTagParam(current: URLSearchParams, token: string): URLSearchParams`
  - `export function removeTagParam(current: URLSearchParams, token: string): URLSearchParams`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/admin/logs.test.ts`:

```ts
test('a single tag param becomes a one-pair filter', () => {
  expect(parseLogFilter({ tag: 'env=prod' }).tags).toEqual({ env: 'prod' })
})

test('repeated tag params are merged into one filter object', () => {
  expect(parseLogFilter({ tag: ['env=prod', 'team=a'] }).tags).toEqual({
    env: 'prod', team: 'a',
  })
})

// The gateway lowercases keys on the way in, so the filter must too — or a
// search for Env=prod finds nothing while the rows sit there stored as env.
test('a tag key is normalized the same way the gateway normalizes it', () => {
  expect(parseLogFilter({ tag: 'ENV=prod' }).tags).toEqual({ env: 'prod' })
})

// parseLogFilter's standing contract: a hand-edited URL shows a view, not an
// error page. The gateway throws on the same input; this side drops it.
test('a malformed tag param is dropped rather than thrown', () => {
  expect(() => parseLogFilter({ tag: 'not a pair' })).not.toThrow()
  expect(parseLogFilter({ tag: 'not a pair' }).tags).toBeUndefined()
})

test('a malformed tag is dropped while a valid sibling survives', () => {
  expect(parseLogFilter({ tag: ['env=prod', 'not a pair'] }).tags).toEqual({ env: 'prod' })
})

test('a duplicated key keeps the first and drops the rest', () => {
  expect(parseLogFilter({ tag: ['env=prod', 'env=staging'] }).tags).toEqual({ env: 'prod' })
})

test('an all-malformed list omits tags from the filter entirely', () => {
  expect(parseLogFilter({ tag: ['bad', 'also bad'] }).tags).toBeUndefined()
})

test('no tag param means no tags filter', () => {
  expect(parseLogFilter({}).tags).toBeUndefined()
})
```

Append to `tests/lib/admin/log-filter-params.test.ts`:

```ts
test('addTagParam appends rather than replacing, so tags accumulate', () => {
  const next = addTagParam(new URLSearchParams('tag=env%3Dprod'), 'team=a')
  expect(next.getAll('tag')).toEqual(['env=prod', 'team=a'])
})

test('addTagParam clears the keyset cursors', () => {
  const next = addTagParam(new URLSearchParams('after=abc&before=def'), 'env=prod')
  expect(next.get('after')).toBeNull()
  expect(next.get('before')).toBeNull()
})

test('addTagParam preserves the other filters', () => {
  const next = addTagParam(new URLSearchParams('range=7d&model=house'), 'env=prod')
  expect(next.get('range')).toBe('7d')
  expect(next.get('model')).toBe('house')
})

test('removeTagParam drops only the named tag', () => {
  const next = removeTagParam(
    new URLSearchParams('tag=env%3Dprod&tag=team%3Da'),
    'env=prod',
  )
  expect(next.getAll('tag')).toEqual(['team=a'])
})

test('removeTagParam clears the keyset cursors', () => {
  const next = removeTagParam(new URLSearchParams('tag=env%3Dprod&after=abc'), 'env=prod')
  expect(next.get('after')).toBeNull()
})

test('removing the last tag leaves no tag param at all', () => {
  const next = removeTagParam(new URLSearchParams('tag=env%3Dprod'), 'env=prod')
  expect(next.getAll('tag')).toEqual([])
})
```

Add `addTagParam` and `removeTagParam` to that file's existing import from
`@/lib/admin/log-filter-params`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/admin/logs.test.ts tests/lib/admin/log-filter-params.test.ts`
Expected: FAIL — `addTagParam` is not exported, and `tag` is not a known search param.

- [ ] **Step 3: Add the URL helpers**

In `src/lib/admin/log-filter-params.ts`, at the end of the file:

```ts
/**
 * Appends one `key=value` token to the tag filter.
 *
 * `nextFilterParams` cannot serve here: it calls `URLSearchParams.set`, which
 * replaces every value of a name, and `tag` is the first multi-valued filter.
 * `NEUTRAL_VALUES` gains no entry for the same reason — "no tag filter" is
 * expressed by having no `tag` params, not by a sentinel value.
 *
 * Cursors are cleared exactly as `nextFilterParams` clears them: a filter
 * change makes the old keyset position meaningless whether the filter holds
 * one value or many.
 */
export function addTagParam(current: URLSearchParams, token: string): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  if (token && !next.getAll('tag').includes(token)) next.append('tag', token)
  next.delete('after')
  next.delete('before')
  return next
}

/** Removes one `key=value` token from the tag filter, leaving the others. */
export function removeTagParam(current: URLSearchParams, token: string): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  const kept = next.getAll('tag').filter((value) => value !== token)
  next.delete('tag')
  for (const value of kept) next.append('tag', value)
  next.delete('after')
  next.delete('before')
  return next
}
```

- [ ] **Step 4: Parse the params into a filter**

In `src/lib/admin/logs.ts`:

Add the import:

```ts
import { parseTags } from '@/lib/tags'
```

Add to `LogSearchParams`, after `status?: string`:

```ts
  /** Repeated `?tag=key=value`. Next supplies an array for a repeated param
   * and a bare string for a single one. */
  tag?: string | string[]
```

Add this function beside `cursor()` and `key()`:

```ts
/**
 * Turns repeated `tag` params into a filter object.
 *
 * Shares `parseTags` with the gateway ingress, so a key typed here is
 * normalized exactly as the gateway normalized it on the way in — otherwise a
 * search for `Env=prod` would find nothing while the rows sat there stored as
 * `env`. The two differ only in what a failure means: the gateway throws a
 * 400, and this drops the token, per this module's standing contract that a
 * hand-edited URL shows the default view rather than an error page.
 *
 * Returns undefined when nothing survives, so the caller omits `tags`
 * entirely rather than sending an empty object the store would have to
 * special-case.
 */
function tagFilter(raw: string | string[] | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  const tokens = Array.isArray(raw) ? raw : [raw]

  const tags: Record<string, string> = {}
  for (const token of tokens) {
    const result = parseTags(token)
    if (!result.ok || !result.tags) continue
    for (const [key, value] of Object.entries(result.tags)) {
      // First wins. A duplicated key in a URL is a hand-edit or a stale link,
      // and silently preferring the last one would change which rows come
      // back with no sign in the filter bar.
      if (!Object.hasOwn(tags, key)) tags[key] = value
    }
  }

  return Object.keys(tags).length > 0 ? tags : undefined
}
```

In `parseLogFilter`, add near the other locals:

```ts
  const tags = tagFilter(params.tag)
```

and in the returned object, after the `outcome` spread:

```ts
    ...(tags ? { tags } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/admin/logs.test.ts tests/lib/admin/log-filter-params.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, then lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/logs.ts src/lib/admin/log-filter-params.ts tests/lib/admin
git commit -m "feat(logs): read tag filters from the /logs query string

Repeated ?tag=key=value params, parsed with the same rules the gateway
applies on ingress so a typed key matches what was stored. Malformed
tokens are dropped rather than thrown, per parseLogFilter's contract."
```

---

## Task 6: Show and set tags in the dashboard

**Files:**
- Modify: `src/app/(admin)/logs/log-filters.tsx`
- Modify: `src/app/(admin)/logs/[id]/page.tsx`

**Interfaces:**
- Consumes: `parseTags` from Task 1; `addTagParam` / `removeTagParam` from Task 5; `LogDetail.tags` from Task 2.
- Produces: no exported interface.

There is no unit test for these components — the repo tests filter behaviour at
the `parseLogFilter` / `log-filter-params` layer, which Task 5 covered. The
verification here is the browser check in Step 5.

- [ ] **Step 1: Add the tag filter to the filter bar**

In `src/app/(admin)/logs/log-filters.tsx`:

Extend the imports:

```ts
import { Badge } from '@/components/ui/badge'
import { X } from 'lucide-react'
import { parseTags } from '@/lib/tags'
import {
  DEFAULT_LOG_PAGE_SIZE, LOG_PAGE_SIZES, addTagParam, nextFilterParams, removeTagParam,
} from '@/lib/admin/log-filter-params'
```

Inside `LogFilters`, beside the existing `requestId` state:

```ts
  const [tagKey, setTagKey] = useState('')
  const [tagValue, setTagValue] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)

  const activeTags = params.getAll('tag')

  function addTag() {
    const token = `${tagKey.trim()}=${tagValue.trim()}`
    // Validated with the gateway's own parser, so the chip shows the
    // normalized form that will actually match, and an invalid tag is
    // refused at the input instead of being silently dropped server-side.
    const parsed = parseTags(token)
    if (!parsed.ok) {
      setTagError(parsed.message)
      return
    }
    if (!parsed.tags) return

    const [key, value] = Object.entries(parsed.tags)[0]
    setTagError(null)
    setTagKey('')
    setTagValue('')
    router.push(`/logs?${addTagParam(params, `${key}=${value}`).toString()}`)
  }

  function dropTag(token: string) {
    router.push(`/logs?${removeTagParam(params, token).toString()}`)
  }
```

Add this block inside the returned markup, after the closing `</form>` and
before the outer closing `</div>`, wrapping the whole bar in a
`<div className="space-y-2">` so the tag row sits under the selects:

```tsx
      <div className="flex w-full flex-wrap items-center gap-2">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            addTag()
          }}
        >
          <Input
            value={tagKey}
            onChange={(event) => setTagKey(event.target.value)}
            placeholder="tag key"
            className="w-32 font-mono text-xs"
            aria-label="Tag key"
          />
          <Input
            value={tagValue}
            onChange={(event) => setTagValue(event.target.value)}
            placeholder="tag value"
            className="w-40 font-mono text-xs"
            aria-label="Tag value"
          />
          <Button type="submit" variant="secondary">Add tag</Button>
        </form>

        {activeTags.map((token) => (
          <Badge key={token} variant="secondary" className="gap-1 font-mono">
            {token}
            <button
              type="button"
              onClick={() => dropTag(token)}
              aria-label={`Remove tag filter ${token}`}
              className="opacity-60 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>

      {tagError ? (
        <p className="w-full text-xs text-destructive">{tagError}</p>
      ) : null}
```

- [ ] **Step 2: Render tags on the detail page**

In `src/app/(admin)/logs/[id]/page.tsx`, add a section immediately before the
existing `{log.droppedParams?.length ? (` block, matching its
render-only-when-present shape:

```tsx
      {log.tags ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Tags</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(log.tags).map(([key, value]) => (
              <Badge key={key} variant="secondary" className="font-mono">
                {key}={value}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}
```

`Badge` is already imported in this file.

- [ ] **Step 3: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors. A `server-only` import reaching the client bundle fails
here — if it does, the cause is an import chain out of `@/lib/tags`, which must
stay import-free.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Browser check**

Start the dashboard against the **separate dev database on 5434, port 3001** —
never `pnpm dev`, which points at the developer's own database on 5432:

```bash
pnpm dev:test-db
```

Then, in the browser at `http://localhost:3001`:

1. Log in with the `ADMIN_PASSWORD` from `.env.test` (`devpassword`).
2. Open `/logs`. Confirm the tag key/value inputs and the "Add tag" button render.
3. Enter key `env`, value `prod`, and add it. Confirm the URL gains `?tag=env%3Dprod`, a chip appears, and the page still renders.
4. Enter key `Bad Key`, value `x`. Confirm the inline error appears and the URL does not change.
5. Click the chip's remove button. Confirm the `tag` param disappears.
6. Stop the server when done. Do not stop the developer's own `pnpm dev` on port 3000.

If there are no logged requests in that database, the table will be empty —
that is fine, this step checks the filter controls, not the rows.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/logs/log-filters.tsx" "src/app/(admin)/logs/[id]/page.tsx"
git commit -m "feat(logs): filter by tag and show tags on the detail page

The filter bar validates a typed pair with the gateway's own parser, so the
chip shows the normalized form that will actually match. Tags render on the
detail page only; the logs table is already at its column budget."
```

---

## Task 7: Document the header

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the contract from Task 1.
- Produces: no code.

- [ ] **Step 1: Write the section**

Insert it as a new `###` section under `## Features`, immediately after the
`### Usage, cost, and logs` section (which ends with a `</details>` block) and
immediately before `### Rate limits and budgets`. That places it beside the
logging behaviour it feeds, at the same heading depth as its neighbours.

```markdown
### Tagging requests

Any request may carry an `x-babellm-tags` header of comma-separated
`key=value` pairs. The gateway records them on the request log, and `/logs`
can filter by any combination of them.

```ts
await client.chat.completions.create(
  { model: "smart", messages: [{ role: "user", content: "Hello" }] },
  { headers: { "x-babellm-tags": "env=prod,feature=checkout,customer=acme-3122" } },
);
```

The rules, all enforced:

| Rule | Limit |
| --- | --- |
| Header size | 2048 bytes |
| Number of tags | 16 |
| Key | `[a-z0-9_.-]`, 1–64 characters, lowercased |
| Value | 1–256 characters, no control characters, no `,` |
| Duplicate keys | rejected |

Keys are lowercased, so `Env` and `env` are one dimension. Values keep their
case. A value cannot contain a comma, because the separator is unescaped.

**A header that breaks any of these rules fails the request with a `400`**
rather than being dropped, and the rejection is logged against the calling
key. This is deliberate: a tag that is silently discarded produces a dashboard
quietly missing a slice of its traffic, with nothing on either side to reveal
it. The request is rejected before any provider is called, so it costs nothing
upstream.

Tags are stored on the request log only. They are not forwarded to providers,
they do not appear in the usage and cost dashboard, and they cannot carry
limits or budgets. They age out with the log rows that hold them, at whatever
retention the logging settings specify.
```

- [ ] **Step 2: Verify the claims against the code**

Re-read `src/lib/tags.ts` and confirm every number and character class in the
table matches the constants there. A README that disagrees with the validator
is worse than no README.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the x-babellm-tags request header

Includes why a malformed header is a 400 rather than a dropped header, and
what tags deliberately do not do."
```

---

## Done

After Task 7, run the full verification once more from the worktree root:

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Then follow `superpowers:verification-before-completion`, and integrate per
`superpowers:finishing-a-development-branch`. Per `AGENTS.md`, merging this
worktree into `main` is a **squash merge** — one commit describing the whole
change — followed by deleting the branch and removing the worktree.
