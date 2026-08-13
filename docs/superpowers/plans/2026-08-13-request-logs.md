# Governance › Request Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every gateway request in a pluggable store and give the admin UI a Governance section to read, filter, and inspect those records.

**Architecture:** A `RequestLogStore` discriminated union with two drivers — `postgres` (readable, default) and `stdout` (write-only, today's behavior). The driver is named by a row in the `settings` table, resolved through a 15-second in-process cache, so operators switch stores without a redeploy. The gateway writes fire-and-forget; a logging failure never becomes a serving failure.

**Tech Stack:** Next.js 16 (App Router, server components, server actions), drizzle-orm 0.45 + Postgres 17, zod 4, vitest 4, shadcn/ui (base-nova, lucide), pnpm.

**Spec:** `docs/superpowers/specs/2026-08-13-request-logs-design.md`

## Global Constraints

- **No new runtime dependencies.** Everything here is built from `drizzle-orm`, `pg`, `zod`, `node:crypto`, and installed shadcn components. The only new package is the shadcn `tabs` component, added via `pnpm dlx shadcn@latest add tabs` in Task 13.
- **Postgres 17.** `uuidv7()` is a Postgres 18 builtin and is NOT available. All v7 ids are generated in TypeScript.
- **Money columns are `numeric(18,9)`.** Catalog price columns stay `numeric(12,6)` — do not change them.
- **`varchar(128)`** for `model` and `final_upstream_model`, truncated at write time.
- **Null, never zero,** for unmeasured tokens and unpriced cost. `0` means "it was free"; `null` means "we do not know".
- **A logging problem never becomes a serving problem.** Every write path swallows its own errors to stderr.
- **`LOG_SETTINGS_TTL_MS = 15_000`** — a named constant, never a literal at a call site.
- **Tests share one real Postgres database** (`vitest.config.ts` sets `fileParallelism: false`). Reset with `resetDb()` from `tests/helpers/db.ts`.
- **Commit after each task** using conventional-commit prefixes (`feat:`, `test:`, `refactor:`, `docs:`).
- Run `pnpm typecheck` and `pnpm lint` before every commit; both must be clean.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/lib/uuid.ts` | `uuidv7()` and `uuidv7Bound()` — nothing else |
| `src/lib/logs/types.ts` | Entry, filter, page, detail, and the sink/store union |
| `src/lib/logs/line.ts` | `buildRequestLog()` — the stdout line shape (moved) |
| `src/lib/logs/stdout.ts` | stdout driver |
| `src/lib/logs/postgres.ts` | postgres driver |
| `src/lib/logs/payload.ts` | Payload capping and the truncation envelope |
| `src/lib/logs/registry.ts` | Driver table, settings cache, store resolution |
| `src/lib/logs/index.ts` | `logRequest()` facade and public re-exports |
| `src/lib/pricing.ts` | Catalog price lookup and cost arithmetic |
| `src/lib/admin/logs.ts` | Filter parsing and read helpers for the admin UI |
| `src/app/(admin)/logs/page.tsx` | Request Logs table |
| `src/app/(admin)/logs/log-filters.tsx` | Client filter bar |
| `src/app/(admin)/logs/[requestId]/page.tsx` | Request detail |
| `src/app/(admin)/settings/page.tsx` | Tabbed settings page |
| `src/app/(admin)/settings/governance-form.tsx` | Governance tab form |
| `src/app/(admin)/settings/actions.ts` | Settings server action |
| `src/instrumentation.ts` | Boot hook: retention timer |

**Modified**

| Path | Change |
|---|---|
| `src/lib/db/schema.ts` | `request_outcome` enum, `request_logs`, `request_payloads` |
| `src/lib/settings.ts` | `getLoggingSettings` / `setLoggingSettings` |
| `src/lib/gateway/sse.ts` | Usage + text capture, richer `onSettle` |
| `src/lib/gateway/chat-handler.ts` | Build the entry, call `logRequest` |
| `src/app/(admin)/layout.tsx` | Grouped nav with a GOVERNANCE section |
| `tests/helpers/db.ts` | Truncate the two new tables |

**Deleted**

| Path | Reason |
|---|---|
| `src/lib/gateway/request-log.ts` | Split into `src/lib/logs/line.ts` + `src/lib/logs/index.ts`. A stdout driver importing a gateway module that imports the driver registry would be a cycle. |

---

### Task 1: uuid v7

**Files:**
- Create: `src/lib/uuid.ts`
- Test: `tests/lib/uuid.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `uuidv7(date?: Date): string` and `uuidv7Bound(date: Date): string`. Every later task uses these; `uuidv7Bound` is the lower bound of every id generated in that millisecond, which makes time-range filters and pruning into primary-key range scans.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/uuid.test.ts
import { expect, test } from 'vitest'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('generates a well-formed uuid with version 7 and the RFC variant', () => {
  const id = uuidv7()
  expect(id).toMatch(UUID_RE)
  // Version nibble is the first character of the third group.
  expect(id[14]).toBe('7')
  // Variant is 10xx, so the first character of the fourth group is 8, 9, a or b.
  expect('89ab').toContain(id[19])
})

test('ids sort in timestamp order as strings', () => {
  const early = uuidv7(new Date('2026-01-01T00:00:00.000Z'))
  const late = uuidv7(new Date('2026-01-01T00:00:00.001Z'))
  expect(early < late).toBe(true)
})

test('two ids in the same millisecond differ', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  expect(uuidv7(at)).not.toBe(uuidv7(at))
})

test('ids generated within one millisecond still increase', () => {
  // The log viewer orders by id and calls that order chronological. Without a
  // counter, ids sharing a millisecond would sort at random and that claim
  // would be false.
  const at = new Date('2026-03-03T03:03:03.003Z')
  const ids = Array.from({ length: 200 }, () => uuidv7(at))
  expect(ids).toEqual([...ids].sort())
  expect(new Set(ids).size).toBe(200)
})

test('a bound is stable and sorts below every id from that millisecond', () => {
  const at = new Date('2026-06-01T12:00:00.000Z')
  const bound = uuidv7Bound(at)

  expect(bound).toBe(uuidv7Bound(at))
  for (let i = 0; i < 50; i++) {
    expect(bound < uuidv7(at)).toBe(true)
  }
})

test('a bound sorts above every id from the previous millisecond', () => {
  const at = new Date('2026-06-01T12:00:00.000Z')
  const before = new Date(at.getTime() - 1)
  expect(uuidv7(before) < uuidv7Bound(at)).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/uuid.test.ts`
Expected: FAIL — cannot resolve `@/lib/uuid`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/uuid.ts
import { randomBytes } from 'node:crypto'

/** rand_a — the 12 bits after the version nibble — is used as a per-millisecond
 * sequence counter, which is RFC 9562 §6.2's "monotonic random" method. */
const MAX_COUNTER = 0xfff

let lastMs = -1
let counter = 0

/**
 * uuid v7: a 48-bit big-endian millisecond timestamp, a 12-bit monotonic
 * counter, and 62 random bits.
 *
 * Generated here rather than by the database because `uuidv7()` is a Postgres
 * 18 builtin and compose pins postgres:17 — and because app-side generation
 * works on whatever version a self-hoster runs.
 *
 * The counter is what lets the log viewer call `ORDER BY id DESC`
 * chronological: without it, two requests landing in the same millisecond
 * would sort at random.
 */
export function uuidv7(date: Date = new Date()): string {
  const ms = date.getTime()
  if (ms === lastMs) {
    // Saturating rather than wrapping: wrapping would sort a later id below an
    // earlier one, which is the exact property the counter exists to provide.
    // Reaching 4096 ids inside one millisecond means over four million per
    // second, at which point ordering within that millisecond degrades to
    // random and nothing else breaks — ids stay unique via rand_b.
    counter = counter < MAX_COUNTER ? counter + 1 : MAX_COUNTER
  } else {
    lastMs = ms
    counter = 0
  }
  return format(compose(ms, counter, randomBytes(8)))
}

/**
 * The lowest uuid v7 that can exist for a timestamp: same time bits, counter
 * and random bits all zero. `id >= uuidv7Bound(t)` therefore selects exactly
 * the rows written at or after `t` — a range scan on the primary key, which is
 * why request_logs needs no created_at index.
 */
export function uuidv7Bound(date: Date): string {
  return format(compose(date.getTime(), 0, new Uint8Array(8)))
}

function compose(ms: number, seq: number, random: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16)

  // Bit shifts are 32-bit in JS and this value is 48-bit, so the high bytes
  // are divided out rather than shifted.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff

  // Version 7 in the high nibble, then the 12-bit counter.
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f)
  bytes[7] = seq & 0xff

  bytes.set(random, 8)
  // Variant 10xx. 0x70 and 0x80 are the smallest legal values of these two
  // bytes, which is what keeps a zeroed bound genuinely minimal.
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return bytes
}

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/uuid.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/uuid.ts tests/lib/uuid.test.ts
git commit -m "feat: add uuid v7 generation with range bounds"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `tests/helpers/db.ts:4-7`
- Create: `drizzle/0003_*.sql` (generated)
- Test: `tests/lib/db/request-logs-schema.test.ts`

**Interfaces:**
- Consumes: `uuidv7` from Task 1.
- Produces: `requestLogs`, `requestPayloads`, `requestOutcomeEnum`, and the row types `RequestLogRow`, `RequestPayloadRow`. Tasks 5, 11, 12 and 14 query these tables.

Structural jsonb types are declared inline rather than imported. `src/lib/gateway/errors.ts` already takes this approach for `AttemptSummary`, and it keeps `schema.ts` free of a dependency on the routing loop and the OpenAI SDK.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/db/request-logs-schema.test.ts
import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requestLogs, requestPayloads } from '@/lib/db/schema'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('a log row round-trips with an app-generated v7 id', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_one',
    keyName: 'prod',
    model: 'house-model',
    status: 200,
    outcome: 'ok',
    latencyMs: 120,
    attempts: [{ n: 1, targetId: 't', provider: 'openai', model: 'gpt-4o-mini', status: 200, latencyMs: 100 }],
  }).returning()

  expect(row.id[14]).toBe('7')
  expect(row.attempts[0].provider).toBe('openai')
  expect(row.costUsd).toBeNull()
  expect(row.payloadCaptured).toBe(false)
})

test('deleting a log cascades to its payload', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_two', status: 200, outcome: 'ok', latencyMs: 1,
  }).returning()

  await db.insert(requestPayloads).values({
    requestLogId: row.id,
    requestJson: { model: 'house-model' },
    responseJson: { ok: true },
  })

  await db.delete(requestLogs).where(eq(requestLogs.id, row.id))
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('cost columns keep nine decimal places', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_three', status: 200, outcome: 'ok', latencyMs: 1,
    costUsd: '0.000000123',
  }).returning()

  expect(Number(row.costUsd)).toBeCloseTo(0.000000123, 12)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/db/request-logs-schema.test.ts`
Expected: FAIL — `requestLogs` is not exported from `@/lib/db/schema`.

- [ ] **Step 3: Add the enum and tables**

Add `varchar` to the existing `drizzle-orm/pg-core` import at the top of `src/lib/db/schema.ts`, add `import { uuidv7 } from '@/lib/uuid'`, and append:

```ts
export const requestOutcomeEnum = pgEnum('request_outcome', [
  'ok', 'error', 'client_closed', 'stream_interrupted',
])

/** One attempt against one route target. Structural, so schema.ts stays free
 * of a dependency on the routing loop. Mirrors AttemptRecord in
 * src/lib/gateway/execute.ts. */
type LoggedAttempt = {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  error?: string
}

/** The per-Mtok rates used to price this request, snapshotted so a later
 * catalog price edit cannot make historical arithmetic unexplainable. */
type LoggedPricing = {
  inputPerMtok: string | null
  cachedInputPerMtok: string | null
  outputPerMtok: string | null
}

export const requestLogs = pgTable(
  'request_logs',
  {
    // v7: time-ordered, so inserts append to the right edge of the B-tree
    // instead of scattering, and the primary key doubles as the pagination,
    // time-range and prune index.
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    requestId: text('request_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // set null, not cascade: a deleted key must not erase the history of what
    // it did. key_name is denormalized for the same reason.
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    keyName: text('key_name'),

    // What the client asked for — a virtual model name or a direct
    // `provider/model` address. Deliberately not a virtual_models FK: a direct
    // address resolves to a catalog row, so the key would point at the wrong
    // table half the time.
    model: varchar('model', { length: 128 }),

    stream: boolean('stream').notNull().default(false),
    status: integer('status').notNull(),
    outcome: requestOutcomeEnum('outcome').notNull(),
    errorType: text('error_type'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    latencyMs: integer('latency_ms').notNull(),
    ttftMs: integer('ttft_ms'),
    attempts: jsonb('attempts').$type<LoggedAttempt[]>().notNull().default([]),

    finalTargetId: uuid('final_target_id'),
    finalProviderId: uuid('final_provider_id'),
    finalProvider: text('final_provider'),
    finalUpstreamModel: varchar('final_upstream_model', { length: 128 }),

    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    cachedTokens: integer('cached_tokens'),
    reasoningTokens: integer('reasoning_tokens'),

    // scale 9, not 6: a small request can cost less than a micro-dollar, and
    // rounding that to 0.000000 is the silent-zero lie in another disguise.
    inputCostUsd: numeric('input_cost_usd', { precision: 18, scale: 9 }),
    cachedCostUsd: numeric('cached_cost_usd', { precision: 18, scale: 9 }),
    outputCostUsd: numeric('output_cost_usd', { precision: 18, scale: 9 }),
    costUsd: numeric('cost_usd', { precision: 18, scale: 9 }),
    pricing: jsonb('pricing').$type<LoggedPricing | null>(),

    droppedParams: jsonb('dropped_params').$type<string[]>(),
    payloadCaptured: boolean('payload_captured').notNull().default(false),
  },
  (table) => [
    uniqueIndex('request_logs_request_id_idx').on(table.requestId),
    index('request_logs_api_key_idx').on(table.apiKeyId, table.id.desc()),
    index('request_logs_model_idx').on(table.model, table.id.desc()),
  ],
)

export const requestPayloads = pgTable('request_payloads', {
  // cascade: pruning a log prunes its payload in the same statement.
  requestLogId: uuid('request_log_id')
    .primaryKey()
    .references(() => requestLogs.id, { onDelete: 'cascade' }),
  requestJson: jsonb('request_json').$type<unknown>(),
  responseJson: jsonb('response_json').$type<unknown>(),
  truncated: boolean('truncated').notNull().default(false),
})

export type RequestLogRow = typeof requestLogs.$inferSelect
export type RequestPayloadRow = typeof requestPayloads.$inferSelect
```

- [ ] **Step 4: Add the tables to the test reset helper**

In `tests/helpers/db.ts`, put the two new tables at the front of `TABLES` (order is cosmetic — `CASCADE` handles dependencies):

```ts
const TABLES = [
  'request_payloads', 'request_logs',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0003_*.sql` creating the enum, both tables, and three indexes. Read it and confirm it contains `CREATE TYPE "public"."request_outcome"`, `ON DELETE cascade` on `request_payloads`, and `ON DELETE set null` on `request_logs.api_key_id`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/db/request-logs-schema.test.ts`
Expected: PASS, 3 tests. The vitest global setup applies pending migrations automatically.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/db/schema.ts tests/helpers/db.ts tests/lib/db/request-logs-schema.test.ts drizzle
git commit -m "feat: add request_logs and request_payloads tables"
```

---

### Task 3: Logging settings

**Files:**
- Modify: `src/lib/settings.ts`
- Test: `tests/lib/logging-settings.test.ts`

**Interfaces:**
- Consumes: the existing `settings` table.
- Produces:

```ts
export interface LoggingSettings {
  store: string
  retentionDays: number
  payloadMaxBytes: number
}
export function getLoggingSettings(): Promise<LoggingSettings>
export function setLoggingSettings(patch: Partial<LoggingSettings>): Promise<LoggingSettings>
```

Task 6 caches the whole bundle; Task 13 edits it; Task 14 reads `retentionDays`.

`setLoggingSettings` does NOT validate the driver name — the driver table lives in `src/lib/logs/registry.ts` and importing it here would invert the dependency. Validation is the settings form's select (Task 13) plus the runtime fallback (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/logging-settings.test.ts
import { beforeEach, expect, test } from 'vitest'
import { getLoggingSettings, setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../helpers/db'

beforeEach(resetDb)

test('defaults to the postgres store with 30 day retention', async () => {
  expect(await getLoggingSettings()).toEqual({
    store: 'postgres',
    retentionDays: 30,
    payloadMaxBytes: 262144,
  })
})

test('persists a patch and leaves the rest alone', async () => {
  await setLoggingSettings({ store: 'stdout' })
  expect(await getLoggingSettings()).toMatchObject({ store: 'stdout', retentionDays: 30 })

  await setLoggingSettings({ retentionDays: 7 })
  expect(await getLoggingSettings()).toMatchObject({ store: 'stdout', retentionDays: 7 })
})

test('accepts zero retention, which means never prune', async () => {
  await setLoggingSettings({ retentionDays: 0 })
  expect((await getLoggingSettings()).retentionDays).toBe(0)
})

test('rejects a negative retention and a non-positive payload cap', async () => {
  await expect(setLoggingSettings({ retentionDays: -1 })).rejects.toThrow(/retention/i)
  await expect(setLoggingSettings({ payloadMaxBytes: 0 })).rejects.toThrow(/payload/i)
})

test('rejects an empty store name', async () => {
  await expect(setLoggingSettings({ store: '  ' })).rejects.toThrow(/store/i)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logging-settings.test.ts`
Expected: FAIL — `getLoggingSettings` is not exported.

- [ ] **Step 3: Implement, appending to `src/lib/settings.ts`**

```ts
export const DEFAULT_LOG_STORE = 'postgres'
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_PAYLOAD_MAX_BYTES = 262_144

export interface LoggingSettings {
  store: string
  /** 0 disables pruning. */
  retentionDays: number
  payloadMaxBytes: number
}

const LOG_KEYS = {
  store: 'logs.store',
  retentionDays: 'logs.retention_days',
  payloadMaxBytes: 'logs.payload_max_bytes',
} as const

export async function getLoggingSettings(): Promise<LoggingSettings> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const store = byKey.get(LOG_KEYS.store)
  const retention = byKey.get(LOG_KEYS.retentionDays)
  const cap = byKey.get(LOG_KEYS.payloadMaxBytes)

  return {
    store: typeof store === 'string' && store.length > 0 ? store : DEFAULT_LOG_STORE,
    retentionDays:
      typeof retention === 'number' && retention >= 0 ? retention : DEFAULT_RETENTION_DAYS,
    payloadMaxBytes:
      typeof cap === 'number' && cap > 0 ? cap : DEFAULT_PAYLOAD_MAX_BYTES,
  }
}

export async function setLoggingSettings(
  patch: Partial<LoggingSettings>,
): Promise<LoggingSettings> {
  const writes: Array<[string, unknown]> = []

  if (patch.store !== undefined) {
    const store = patch.store.trim()
    if (!store) throw new Error('A log store is required.')
    writes.push([LOG_KEYS.store, store])
  }
  if (patch.retentionDays !== undefined) {
    if (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 0) {
      throw new Error('Log retention must be a whole number of days, or 0 to keep everything.')
    }
    writes.push([LOG_KEYS.retentionDays, patch.retentionDays])
  }
  if (patch.payloadMaxBytes !== undefined) {
    if (!Number.isInteger(patch.payloadMaxBytes) || patch.payloadMaxBytes < 1) {
      throw new Error('The payload cap must be a positive number of bytes.')
    }
    writes.push([LOG_KEYS.payloadMaxBytes, patch.payloadMaxBytes])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }

  return getLoggingSettings()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/logging-settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/settings.ts tests/lib/logging-settings.test.ts
git commit -m "feat: add logging settings to the settings table"
```

---

### Task 4: Store types, the log line, and the stdout driver

**Files:**
- Create: `src/lib/logs/types.ts`, `src/lib/logs/line.ts`, `src/lib/logs/stdout.ts`
- Delete: `src/lib/gateway/request-log.ts`
- Move: `tests/gateway/request-log.test.ts` → `tests/gateway/stdout-logging.test.ts`
- Test: `tests/lib/logs/line.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the entire type vocabulary every later task uses.

```ts
export type RequestOutcome = 'ok' | 'error' | 'client_closed' | 'stream_interrupted'

export interface LoggedAttempt {
  n: number; targetId: string; provider: string; model: string
  status: number; latencyMs: number; error?: string
}
export interface LogUsage {
  promptTokens: number | null; completionTokens: number | null
  cachedTokens: number | null; reasoningTokens: number | null
}
export interface PricingSnapshot {
  inputPerMtok: string | null; cachedInputPerMtok: string | null; outputPerMtok: string | null
}
export interface CostBreakdown {
  inputUsd: string | null; cachedUsd: string | null
  outputUsd: string | null; totalUsd: string | null
  pricing: PricingSnapshot | null
}
export interface LogPayload { request: unknown; response: unknown; truncated: boolean }
export interface FinalTarget {
  targetId: string; providerId: string; provider: string; upstreamModel: string
}
export interface RequestLogEntry {
  requestId: string
  keyId: string | null
  keyName: string | null
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  errorType?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs: number
  ttftMs?: number
  attempts: LoggedAttempt[]
  final?: FinalTarget | null
  usage?: LogUsage | null
  cost?: CostBreakdown | null
  droppedParams?: string[]
  payload?: LogPayload | null
}
export function buildRequestLog(entry: RequestLogEntry): Record<string, unknown>
export const stdoutStore: WriteOnlySink
```

`buildRequestLog` moves verbatim apart from its parameter type and three new keys. Its existing behavior — snake_case, the `lvl` computation, `stream_interrupted` counting as an error despite a 200 — is covered by tests that must keep passing.

- [ ] **Step 1: Write the failing test for the new keys**

```ts
// tests/lib/logs/line.test.ts
import { expect, test } from 'vitest'
import { buildRequestLog } from '@/lib/logs/line'
import type { RequestLogEntry } from '@/lib/logs/types'

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: 'req_1', keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 42, attempts: [],
    ...overrides,
  }
}

test('a plain request keeps the shape the aggregator already parses', () => {
  expect(buildRequestLog(entry())).toMatchObject({
    lvl: 'info', msg: 'gateway.request', request_id: 'req_1',
    key: 'prod', model: 'house-model', stream: false,
    status: 200, outcome: 'ok', latency_ms: 42, attempts: [],
  })
})

test('a stream interrupted after its 200 is logged at error', () => {
  expect(buildRequestLog(entry({ outcome: 'stream_interrupted' })).lvl).toBe('error')
})

test('a 4xx is a warning and a 5xx is an error', () => {
  expect(buildRequestLog(entry({ status: 429, outcome: 'error' })).lvl).toBe('warn')
  expect(buildRequestLog(entry({ status: 502, outcome: 'error' })).lvl).toBe('error')
})

test('token counts appear only when they were measured', () => {
  expect(buildRequestLog(entry())).not.toHaveProperty('prompt_tokens')

  const withUsage = buildRequestLog(entry({
    usage: { promptTokens: 10, completionTokens: 4, cachedTokens: null, reasoningTokens: null },
  }))
  expect(withUsage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4 })
  expect(withUsage).not.toHaveProperty('cached_tokens')
})

test('cost appears only when the request could be priced', () => {
  const unpriced = buildRequestLog(entry({
    cost: { inputUsd: null, cachedUsd: null, outputUsd: null, totalUsd: null, pricing: null },
  }))
  expect(unpriced).not.toHaveProperty('cost_usd')

  const priced = buildRequestLog(entry({
    cost: {
      inputUsd: '0.000100000', cachedUsd: null, outputUsd: '0.000200000',
      totalUsd: '0.000300000', pricing: null,
    },
  }))
  expect(priced.cost_usd).toBe('0.000300000')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/line.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/line`.

- [ ] **Step 3: Create `src/lib/logs/types.ts`**

Write the full type vocabulary from the Interfaces block above, plus the store union:

```ts
interface BaseSink {
  readonly name: string
  write(entry: RequestLogEntry): Promise<void>
  /** Rows removed. A driver with no retention concept returns 0. */
  prune(olderThan: Date): Promise<number>
  /** Drain anything buffered. Called on shutdown. */
  flush?(): Promise<void>
}

export interface WriteOnlySink extends BaseSink {
  readonly readable: false
}

export interface ReadableRequestLogStore extends BaseSink {
  readonly readable: true
  query(filter: LogFilter): Promise<LogPage>
  get(requestId: string): Promise<LogDetail | null>
}

/**
 * A discriminated union rather than one interface with a boolean flag:
 * `if (store.readable)` narrows a union to its readable member, while a
 * boolean property on a single interface narrows nothing. That is what lets
 * the admin page branch on capability at compile time instead of calling a
 * query() that throws in production.
 */
export type RequestLogStore = WriteOnlySink | ReadableRequestLogStore

export type StatusClass = 'success' | 'client_error' | 'server_error'

export interface LogFilter {
  from?: Date
  to?: Date
  apiKeyId?: string
  model?: string
  statusClass?: StatusClass
  outcome?: RequestOutcome
  /** Keyset cursors — uuid v7 ids. `after` pages older, `before` pages newer. */
  after?: string
  before?: string
  limit: number
}

export interface LogRow {
  id: string
  requestId: string
  createdAt: Date
  keyName: string | null
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  latencyMs: number
  ttftMs: number | null
  finalProvider: string | null
  finalUpstreamModel: string | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: string | null
  payloadCaptured: boolean
}

export interface LogPage {
  rows: LogRow[]
  nextCursor: string | null
  prevCursor: string | null
}

export interface LogDetail extends LogRow {
  errorType: string | null
  errorCode: string | null
  errorMessage: string | null
  attempts: LoggedAttempt[]
  finalTargetId: string | null
  cachedTokens: number | null
  reasoningTokens: number | null
  inputCostUsd: string | null
  cachedCostUsd: string | null
  outputCostUsd: string | null
  pricing: PricingSnapshot | null
  droppedParams: string[] | null
  payload: LogPayload | null
}
```

- [ ] **Step 4: Create `src/lib/logs/line.ts`**

Copy the body of `src/lib/gateway/request-log.ts` — `level()` and `buildRequestLog()` with their comments — changing the parameter type to `RequestLogEntry`, `fields.key` to `entry.keyName`, and adding the token and cost keys:

```ts
import type { RequestLogEntry } from './types'

function level(entry: RequestLogEntry): 'info' | 'warn' | 'error' {
  // A stream that dies after its first chunk has already committed a 200, so
  // the status alone would report a failed request as a success.
  if (entry.outcome === 'stream_interrupted' || entry.status >= 500) return 'error'
  if (entry.status >= 400) return 'warn'
  return 'info'
}

/** Emits a key only when the number was actually measured. A missing count
 * and a count of zero mean different things and must not serialize alike. */
function measured(key: string, value: number | null | undefined) {
  return value === null || value === undefined ? {} : { [key]: value }
}

export function buildRequestLog(entry: RequestLogEntry): Record<string, unknown> {
  return {
    lvl: level(entry),
    msg: 'gateway.request',
    request_id: entry.requestId,
    key: entry.keyName,
    model: entry.model,
    stream: entry.stream,
    status: entry.status,
    outcome: entry.outcome,
    latency_ms: entry.latencyMs,
    ...(entry.ttftMs === undefined ? {} : { ttft_ms: entry.ttftMs }),
    ...(entry.droppedParams?.length ? { dropped_params: entry.droppedParams } : {}),
    ...measured('prompt_tokens', entry.usage?.promptTokens),
    ...measured('completion_tokens', entry.usage?.completionTokens),
    ...measured('cached_tokens', entry.usage?.cachedTokens),
    ...measured('reasoning_tokens', entry.usage?.reasoningTokens),
    ...(entry.cost?.totalUsd ? { cost_usd: entry.cost.totalUsd } : {}),
    attempts: entry.attempts.map((attempt) => ({
      n: attempt.n,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latency_ms: attempt.latencyMs,
      ...(attempt.error ? { error: attempt.error } : {}),
    })),
  }
}
```

`targetId` stays out of the stdout line deliberately: it is a uuid nobody can resolve without the database, and the provider/model pair identifies the attempt for anyone reading stdout. It IS stored in the `attempts` jsonb by the postgres driver.

- [ ] **Step 5: Create `src/lib/logs/stdout.ts`**

```ts
import { buildRequestLog } from './line'
import type { RequestLogEntry, WriteOnlySink } from './types'

/**
 * Writes one line to stdout. Never throws: a request that succeeded must not
 * be turned into a failure by its own logging.
 */
export const stdoutStore: WriteOnlySink = {
  name: 'stdout',
  readable: false,

  async write(entry: RequestLogEntry): Promise<void> {
    try {
      console.log(JSON.stringify(buildRequestLog(entry)))
    } catch (err) {
      // The fallback needs its own guard: stdout and stderr are frequently the
      // same pipe, so whatever just broke console.log has usually broken this
      // too. A request that succeeded must not be failed by its own logging,
      // and that promise is worth more than the diagnostic.
      try {
        console.error(`[gateway] failed to emit request log request_id=${entry.requestId}`, err)
      } catch {
        // Nowhere left to report to.
      }
    }
  },

  /** stdout has no retention concept — the log shipper owns that. */
  async prune(): Promise<number> {
    return 0
  },
}
```

- [ ] **Step 6: Delete the old module and rename its test**

```bash
git rm src/lib/gateway/request-log.ts
git mv tests/gateway/request-log.test.ts tests/gateway/stdout-logging.test.ts
```

`tests/gateway/stdout-logging.test.ts` will not compile until Task 8 rewires `chat-handler.ts`. That is expected: it exercises the handler, not the line builder, and Task 8 restores it. Its assertions do not change.

- [ ] **Step 7: Run the new test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/line.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

Do NOT run the full suite yet — `chat-handler.ts` still imports the deleted module and Task 8 fixes it.

```bash
pnpm lint
git add src/lib/logs tests/lib/logs
git commit -m "refactor: move the request log line into a pluggable logs module"
```

---

### Task 5: Payload capping

**Files:**
- Create: `src/lib/logs/payload.ts`
- Test: `tests/lib/logs/payload.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `capPayload(value: unknown, maxBytes: number): { value: unknown; truncated: boolean }`. Task 9 calls it before every payload insert.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/logs/payload.test.ts
import { expect, test } from 'vitest'
import { capPayload } from '@/lib/logs/payload'

test('a small payload passes through untouched', () => {
  const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }
  expect(capPayload(body, 1024)).toEqual({ value: body, truncated: false })
})

test('an oversized payload becomes a valid-JSON envelope', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  const capped = capPayload(body, 512) as { value: Record<string, unknown>; truncated: boolean }

  expect(capped.truncated).toBe(true)
  expect(capped.value.truncated).toBe(true)
  expect(capped.value.bytes).toBeGreaterThan(5000)
  expect(typeof capped.value.preview).toBe('string')
  // The whole point of an envelope over a clipped string: it survives a
  // round trip through a jsonb column.
  expect(() => JSON.parse(JSON.stringify(capped.value))).not.toThrow()
})

test('the preview stays within the cap', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  const capped = capPayload(body, 512) as { value: { preview: string } }
  expect(Buffer.byteLength(capped.preview ?? '', 'utf8')).toBeLessThanOrEqual(512)
})

test('a value that cannot be serialized becomes an envelope rather than throwing', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const capped = capPayload(cyclic, 1024) as { value: Record<string, unknown>; truncated: boolean }

  expect(capped.truncated).toBe(true)
  expect(capped.value.error).toBe('unserializable')
})

test('null and undefined pass through as null', () => {
  expect(capPayload(undefined, 1024)).toEqual({ value: null, truncated: false })
  expect(capPayload(null, 1024)).toEqual({ value: null, truncated: false })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/payload.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/payload`.

- [ ] **Step 3: Implement**

```ts
// src/lib/logs/payload.ts

/**
 * Bounds what a payload can cost in the database.
 *
 * An oversized payload is replaced rather than clipped: a truncated JSON
 * string is not valid JSON, and the column is jsonb. The envelope keeps the
 * column honestly typed and gives the UI exactly one shape to parse.
 */
export function capPayload(
  value: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }

  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? 'null'
  } catch {
    // A cyclic or otherwise unserializable body must not take down the log
    // write that mentions it.
    return { value: { truncated: true, error: 'unserializable' }, truncated: true }
  }

  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= maxBytes) return { value, truncated: false }

  return {
    value: {
      truncated: true,
      bytes,
      // Sliced on bytes, not characters, so a multi-byte character near the
      // boundary cannot push the preview back over the cap.
      preview: Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8'),
    },
    truncated: true,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/payload.test.ts`
Expected: PASS, 5 tests.

Note: `subarray().toString('utf8')` can leave a replacement character at the boundary if it cuts a multi-byte sequence. That is acceptable for a preview and keeps the byte guarantee the test asserts.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/payload.ts tests/lib/logs/payload.test.ts
git commit -m "feat: cap oversized log payloads with a valid-JSON envelope"
```

---

### Task 6: The postgres driver

**Files:**
- Create: `src/lib/logs/postgres.ts`
- Test: `tests/lib/logs/postgres-store.test.ts`

**Interfaces:**
- Consumes: `requestLogs`/`requestPayloads` (Task 2), the types (Task 4), `uuidv7Bound` (Task 1).
- Produces: `postgresStore: ReadableRequestLogStore`. Task 7 registers it; Tasks 11–12 read through it; Task 14 prunes through it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/logs/postgres-store.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { requestPayloads } from '@/lib/db/schema'
import { postgresStore } from '@/lib/logs/postgres'
import type { RequestLogEntry } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('a written entry comes back from query', async () => {
  await postgresStore.write(entry({ requestId: 'req_a', model: 'house-model' }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ requestId: 'req_a', model: 'house-model', status: 200 })
})

test('get returns the attempt chain and the payload', async () => {
  await postgresStore.write(entry({
    requestId: 'req_b',
    attempts: [
      { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
      { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
    ],
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }))

  const detail = await postgresStore.get('req_b')
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0].error).toBe('down')
  expect(detail?.payloadCaptured).toBe(true)
  expect(detail?.payload?.request).toEqual({ model: 'house-model' })
})

test('get returns null for an unknown request id', async () => {
  expect(await postgresStore.get('req_missing')).toBeNull()
})

test('an entry without a payload records payload_captured false', async () => {
  await postgresStore.write(entry({ requestId: 'req_c' }))
  const detail = await postgresStore.get('req_c')
  expect(detail?.payloadCaptured).toBe(false)
  expect(detail?.payload).toBeNull()
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('filters by key, model, status class and outcome', async () => {
  await postgresStore.write(entry({ requestId: 'ok1', model: 'a', status: 200, outcome: 'ok' }))
  await postgresStore.write(entry({ requestId: 'bad', model: 'b', status: 429, outcome: 'error' }))
  await postgresStore.write(entry({ requestId: 'oops', model: 'a', status: 502, outcome: 'error' }))

  expect((await postgresStore.query({ limit: 10, model: 'a' })).rows).toHaveLength(2)
  expect((await postgresStore.query({ limit: 10, statusClass: 'client_error' })).rows)
    .toMatchObject([{ requestId: 'bad' }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'server_error' })).rows)
    .toMatchObject([{ requestId: 'oops' }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'success' })).rows)
    .toMatchObject([{ requestId: 'ok1' }])
  expect((await postgresStore.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(2)
})

test('pages newest first and walks both directions', async () => {
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    await postgresStore.write(entry({ requestId: id }))
  }

  const first = await postgresStore.query({ limit: 2 })
  expect(first.rows.map((r) => r.requestId)).toEqual(['r5', 'r4'])
  expect(first.nextCursor).not.toBeNull()

  const second = await postgresStore.query({ limit: 2, after: first.nextCursor! })
  expect(second.rows.map((r) => r.requestId)).toEqual(['r3', 'r2'])

  const back = await postgresStore.query({ limit: 2, before: second.prevCursor! })
  expect(back.rows.map((r) => r.requestId)).toEqual(['r5', 'r4'])
})

test('paging back to the newest page reports no newer page', async () => {
  for (const id of ['p1', 'p2', 'p3']) {
    await postgresStore.write(entry({ requestId: id }))
  }

  const first = await postgresStore.query({ limit: 2 })
  const back = await postgresStore.query({ limit: 2, before: first.nextCursor! })

  // At the top of the list there is nothing newer, so the UI must be able to
  // disable "Newer" rather than offering a click that lands on an empty page.
  expect(back.rows.map((r) => r.requestId)).toEqual(['p3', 'p2'])
  expect(back.prevCursor).toBeNull()
})

test('an over-long model name is truncated rather than failing the write', async () => {
  await postgresStore.write(entry({ requestId: 'req_long', model: 'm'.repeat(400) }))
  const detail = await postgresStore.get('req_long')
  expect(detail?.model).toHaveLength(128)
})

/** Puts a real millisecond boundary between two writes. `Date.now() + 1` is
 * not enough: the following write can land in the same millisecond as the
 * bound, putting the row on the wrong side of it for reasons unrelated to the
 * code under test. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('prune deletes old rows, their payloads, and reports the count', async () => {
  await postgresStore.write(entry({ requestId: 'old', payload: { request: {}, response: {}, truncated: false } }))
  await tick()
  const cutoff = new Date()
  await tick()
  await postgresStore.write(entry({ requestId: 'new' }))

  expect(await postgresStore.prune(cutoff)).toBe(1)
  expect((await postgresStore.query({ limit: 10 })).rows).toMatchObject([{ requestId: 'new' }])
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('a time range filter selects by id bound', async () => {
  await postgresStore.write(entry({ requestId: 'before' }))
  await tick()
  const from = new Date()
  await tick()
  await postgresStore.write(entry({ requestId: 'after' }))

  expect((await postgresStore.query({ limit: 10, from })).rows)
    .toMatchObject([{ requestId: 'after' }])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/postgres`.

- [ ] **Step 3: Implement**

```ts
// src/lib/logs/postgres.ts
import 'server-only'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requestLogs, requestPayloads } from '@/lib/db/schema'
import { uuidv7Bound } from '@/lib/uuid'
import type {
  LogDetail, LogFilter, LogPage, LogRow, ReadableRequestLogStore, RequestLogEntry,
} from './types'

const MODEL_MAX_LENGTH = 128
const PRUNE_BATCH = 5000

/** An absurd model name in a request must not become a failed insert that
 * loses the log line. */
function clamp(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MODEL_MAX_LENGTH ? value.slice(0, MODEL_MAX_LENGTH) : value
}

const LIST_COLUMNS = {
  id: requestLogs.id,
  requestId: requestLogs.requestId,
  createdAt: requestLogs.createdAt,
  keyName: requestLogs.keyName,
  model: requestLogs.model,
  stream: requestLogs.stream,
  status: requestLogs.status,
  outcome: requestLogs.outcome,
  latencyMs: requestLogs.latencyMs,
  ttftMs: requestLogs.ttftMs,
  finalProvider: requestLogs.finalProvider,
  finalUpstreamModel: requestLogs.finalUpstreamModel,
  promptTokens: requestLogs.promptTokens,
  completionTokens: requestLogs.completionTokens,
  costUsd: requestLogs.costUsd,
  payloadCaptured: requestLogs.payloadCaptured,
}

function conditions(filter: LogFilter) {
  const where = []
  // Time ranges ride the primary key: a v7 id encodes its own timestamp, so
  // this is a range scan on the PK rather than a second index to maintain.
  if (filter.from) where.push(gte(requestLogs.id, uuidv7Bound(filter.from)))
  if (filter.to) where.push(lt(requestLogs.id, uuidv7Bound(filter.to)))
  if (filter.apiKeyId) where.push(eq(requestLogs.apiKeyId, filter.apiKeyId))
  if (filter.model) where.push(eq(requestLogs.model, filter.model))
  if (filter.outcome) where.push(eq(requestLogs.outcome, filter.outcome))
  if (filter.statusClass === 'success') where.push(lt(requestLogs.status, 400))
  if (filter.statusClass === 'client_error') {
    where.push(gte(requestLogs.status, 400), lt(requestLogs.status, 500))
  }
  if (filter.statusClass === 'server_error') where.push(gte(requestLogs.status, 500))
  return where
}

export const postgresStore: ReadableRequestLogStore = {
  name: 'postgres',
  readable: true,

  async write(entry: RequestLogEntry): Promise<void> {
    // One transaction for both rows. Capping already happened in the caller,
    // so the only remaining failure mode is the database itself — and losing
    // both rows together is the coherent outcome.
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(requestLogs).values({
        requestId: entry.requestId,
        apiKeyId: entry.keyId,
        keyName: entry.keyName,
        model: clamp(entry.model),
        stream: entry.stream,
        status: entry.status,
        outcome: entry.outcome,
        errorType: entry.errorType ?? null,
        errorCode: entry.errorCode ?? null,
        errorMessage: entry.errorMessage ?? null,
        latencyMs: entry.latencyMs,
        ttftMs: entry.ttftMs ?? null,
        attempts: entry.attempts,
        finalTargetId: entry.final?.targetId ?? null,
        finalProviderId: entry.final?.providerId ?? null,
        finalProvider: entry.final?.provider ?? null,
        finalUpstreamModel: clamp(entry.final?.upstreamModel),
        promptTokens: entry.usage?.promptTokens ?? null,
        completionTokens: entry.usage?.completionTokens ?? null,
        cachedTokens: entry.usage?.cachedTokens ?? null,
        reasoningTokens: entry.usage?.reasoningTokens ?? null,
        inputCostUsd: entry.cost?.inputUsd ?? null,
        cachedCostUsd: entry.cost?.cachedUsd ?? null,
        outputCostUsd: entry.cost?.outputUsd ?? null,
        costUsd: entry.cost?.totalUsd ?? null,
        pricing: entry.cost?.pricing ?? null,
        droppedParams: entry.droppedParams?.length ? entry.droppedParams : null,
        payloadCaptured: entry.payload != null,
      }).returning({ id: requestLogs.id })

      if (entry.payload) {
        await tx.insert(requestPayloads).values({
          requestLogId: row.id,
          requestJson: entry.payload.request,
          responseJson: entry.payload.response,
          truncated: entry.payload.truncated,
        })
      }
    })
  },

  async query(filter: LogFilter): Promise<LogPage> {
    const where = conditions(filter)
    // `before` walks toward newer rows, so it queries ascending and reverses.
    const paging = filter.before
      ? { bound: sql`${requestLogs.id} > ${filter.before}`, order: asc(requestLogs.id) }
      : {
          bound: filter.after ? sql`${requestLogs.id} < ${filter.after}` : undefined,
          order: desc(requestLogs.id),
        }
    if (paging.bound) where.push(paging.bound)

    // One extra row answers "is there another page?" without a count query.
    const found = await db
      .select(LIST_COLUMNS)
      .from(requestLogs)
      .where(where.length ? and(...where) : undefined)
      .orderBy(paging.order)
      .limit(filter.limit + 1)

    const hasMore = found.length > filter.limit
    const page = found.slice(0, filter.limit)
    const rows = (filter.before ? page.reverse() : page) as LogRow[]

    // Each cursor is non-null only when a page genuinely exists in that
    // direction. On a `before` page that means consulting `hasMore` — the
    // ascending query computed it to answer exactly this question, and
    // ignoring it would leave the UI offering a "Newer" button at the top of
    // the list that lands on an empty page. In the other two directions the
    // invariant does the work: you only hold an `after` cursor because you
    // paged down past newer rows, and you only hold a `before` cursor because
    // you paged up past older ones.
    return {
      rows,
      nextCursor: rows.length && (filter.before || hasMore) ? rows[rows.length - 1].id : null,
      prevCursor:
        rows.length && (filter.after || (filter.before && hasMore)) ? rows[0].id : null,
    }
  },

  async get(requestId: string): Promise<LogDetail | null> {
    const [found] = await db
      .select({ log: requestLogs, payload: requestPayloads })
      .from(requestLogs)
      .leftJoin(requestPayloads, eq(requestPayloads.requestLogId, requestLogs.id))
      .where(eq(requestLogs.requestId, requestId))
      .limit(1)

    if (!found) return null
    const { log, payload } = found

    return {
      id: log.id,
      requestId: log.requestId,
      createdAt: log.createdAt,
      keyName: log.keyName,
      model: log.model,
      stream: log.stream,
      status: log.status,
      outcome: log.outcome,
      latencyMs: log.latencyMs,
      ttftMs: log.ttftMs,
      finalProvider: log.finalProvider,
      finalUpstreamModel: log.finalUpstreamModel,
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      costUsd: log.costUsd,
      payloadCaptured: log.payloadCaptured,
      errorType: log.errorType,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      attempts: log.attempts,
      finalTargetId: log.finalTargetId,
      cachedTokens: log.cachedTokens,
      reasoningTokens: log.reasoningTokens,
      inputCostUsd: log.inputCostUsd,
      cachedCostUsd: log.cachedCostUsd,
      outputCostUsd: log.outputCostUsd,
      pricing: log.pricing ?? null,
      droppedParams: log.droppedParams,
      // A payload row can be absent even when payload_captured is true, if the
      // row was written by an older version or removed by hand. Read it
      // defensively rather than trusting the flag.
      payload: payload
        ? { request: payload.requestJson, response: payload.responseJson, truncated: payload.truncated }
        : null,
    }
  },

  async prune(olderThan: Date): Promise<number> {
    const bound = uuidv7Bound(olderThan)
    let total = 0

    // Batched so a first prune over a large backlog never holds one enormous
    // transaction. `id <` is a range scan on the primary key, and payloads
    // follow through the cascade.
    for (;;) {
      const result = await db.execute(sql`
        DELETE FROM request_logs
        WHERE id IN (
          SELECT id FROM request_logs WHERE id < ${bound} ORDER BY id LIMIT ${PRUNE_BATCH}
        )
      `)
      const deleted = result.rowCount ?? 0
      total += deleted
      if (deleted < PRUNE_BATCH) return total
    }
  },
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: PASS, 9 tests.

If the paging test fails because several rows landed in the same millisecond, that is a real bug in the cursor logic rather than flakiness: Task 1's generator carries a per-millisecond counter, so ids from one millisecond still increase in creation order. Do not "fix" such a failure by adding sleeps between the writes.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/postgres.ts tests/lib/logs/postgres-store.test.ts
git commit -m "feat: add the postgres request log driver"
```

---

### Task 7: The driver registry, the settings cache, and `logRequest`

**Files:**
- Create: `src/lib/logs/registry.ts`, `src/lib/logs/index.ts`
- Test: `tests/lib/logs/registry.test.ts`

**Interfaces:**
- Consumes: `getLoggingSettings` (Task 3), `stdoutStore` (Task 4), `postgresStore` (Task 6).
- Produces:

```ts
export const DRIVERS: Record<string, RequestLogStore>
export const LOG_SETTINGS_TTL_MS = 15_000
export interface StoreResolution {
  store: RequestLogStore
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  settings: LoggingSettings
}
export function resolveRequestLogStore(): Promise<StoreResolution>
export function clearRequestLogStoreCache(): void
export function logRequest(entry: RequestLogEntry): Promise<void>   // from ./index
```

Task 9 calls `logRequest`; Tasks 12–14 call `resolveRequestLogStore`; Task 14's server action calls `clearRequestLogStoreCache`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/logs/registry.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as settingsModule from '@/lib/settings'
import { setLoggingSettings } from '@/lib/settings'
import {
  LOG_SETTINGS_TTL_MS, clearRequestLogStoreCache, resolveRequestLogStore,
} from '@/lib/logs/registry'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

test('resolves the postgres store by default', async () => {
  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.store.readable).toBe(true)
  expect(resolved.fallback).toBeNull()
})

test('resolves the configured store', async () => {
  await setLoggingSettings({ store: 'stdout' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.store.readable).toBe(false)
})

test('serves from cache instead of querying again', async () => {
  const spy = vi.spyOn(settingsModule, 'getLoggingSettings')
  await resolveRequestLogStore()
  await resolveRequestLogStore()
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(1)
})

test('re-reads once the ttl expires', async () => {
  vi.useFakeTimers()
  const spy = vi.spyOn(settingsModule, 'getLoggingSettings')

  await resolveRequestLogStore()
  vi.advanceTimersByTime(LOG_SETTINGS_TTL_MS + 1)
  await resolveRequestLogStore()

  expect(spy).toHaveBeenCalledTimes(2)
})

test('an unknown driver name falls back to stdout and says so', async () => {
  await setLoggingSettings({ store: 'clickhouse' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.configured).toBe('clickhouse')
  expect(resolved.fallback).toBe('unknown_driver')
})

test('a failed settings read falls back to stdout and caches the fallback', async () => {
  const spy = vi
    .spyOn(settingsModule, 'getLoggingSettings')
    .mockRejectedValue(new Error('connection refused'))

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.fallback).toBe('settings_error')

  // A database hiccup must not turn the cheapest path in the request into a
  // retry storm.
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/registry.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/registry`.

- [ ] **Step 3: Implement the registry**

```ts
// src/lib/logs/registry.ts
import 'server-only'
import {
  DEFAULT_PAYLOAD_MAX_BYTES, DEFAULT_RETENTION_DAYS, getLoggingSettings,
  type LoggingSettings,
} from '@/lib/settings'
import { postgresStore } from './postgres'
import { stdoutStore } from './stdout'
import type { RequestLogStore } from './types'

/** Every driver the gateway ships. Adding one is a fork's single entry here
 * plus a module implementing RequestLogStore. */
export const DRIVERS: Record<string, RequestLogStore> = {
  postgres: postgresStore,
  stdout: stdoutStore,
}

/**
 * How long a resolved store and its settings are trusted.
 *
 * The whole bundle is cached, not just the driver name: caching only the name
 * would trade one query per request for two. The cost is that a store switch
 * takes up to this long to reach other instances, which the Governance tab
 * states plainly.
 */
export const LOG_SETTINGS_TTL_MS = 15_000

export interface StoreResolution {
  store: RequestLogStore
  /** The driver name that was configured, which may not be the one resolved. */
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  settings: LoggingSettings
}

let cached: { at: number; resolution: StoreResolution } | null = null

export function clearRequestLogStoreCache(): void {
  cached = null
}

export async function resolveRequestLogStore(): Promise<StoreResolution> {
  if (cached && Date.now() - cached.at < LOG_SETTINGS_TTL_MS) return cached.resolution

  const resolution = await resolve()
  cached = { at: Date.now(), resolution }
  return resolution
}

export async function getRequestLogStore(): Promise<RequestLogStore> {
  return (await resolveRequestLogStore()).store
}

async function resolve(): Promise<StoreResolution> {
  let settings: LoggingSettings
  try {
    settings = await getLoggingSettings()
  } catch (err) {
    console.error('[gateway] could not read logging settings; logging to stdout', err)
    // Refusing to serve requests because a *logging* setting could not be read
    // would be the wrong hierarchy of concerns.
    return {
      store: stdoutStore,
      configured: 'unknown',
      fallback: 'settings_error',
      settings: {
        store: stdoutStore.name,
        retentionDays: DEFAULT_RETENTION_DAYS,
        payloadMaxBytes: DEFAULT_PAYLOAD_MAX_BYTES,
      },
    }
  }

  const store = DRIVERS[settings.store]
  if (!store) {
    console.error(
      `[gateway] no request log driver named "${settings.store}"; logging to stdout`,
    )
    return { store: stdoutStore, configured: settings.store, fallback: 'unknown_driver', settings }
  }

  return { store, configured: settings.store, fallback: null, settings }
}
```

- [ ] **Step 4: Implement the facade**

```ts
// src/lib/logs/index.ts
import 'server-only'
import { getRequestLogStore } from './registry'
import type { RequestLogEntry } from './types'

/**
 * Writes one request log entry to whichever store is configured.
 *
 * Callers must not await this on the request path — a log write is not worth
 * a millisecond of client latency. It still rejects rather than swallowing,
 * so the caller's .catch() can report the failure to stderr.
 */
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const store = await getRequestLogStore()
  await store.write(entry)
}

export {
  DRIVERS, LOG_SETTINGS_TTL_MS, clearRequestLogStoreCache,
  getRequestLogStore, resolveRequestLogStore,
} from './registry'
export type { StoreResolution } from './registry'
export * from './types'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/registry.test.ts`
Expected: PASS, 6 tests.

If `vi.spyOn(settingsModule, 'getLoggingSettings')` does not intercept the call, it is because `registry.ts` captured the binding at import time. Import the module namespace in `registry.ts` (`import * as settings from '@/lib/settings'` and call `settings.getLoggingSettings()`) rather than weakening the test.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/registry.ts src/lib/logs/index.ts tests/lib/logs/registry.test.ts
git commit -m "feat: resolve the log store from settings behind a 15s cache"
```

---

### Task 8: Pricing

**Files:**
- Create: `src/lib/pricing.ts`
- Test: `tests/lib/pricing.test.ts`

**Interfaces:**
- Consumes: `catalogModels` (existing schema), `LogUsage`/`PricingSnapshot`/`CostBreakdown` (Task 4).
- Produces:

```ts
export function computeCost(prices: PricingSnapshot | null, usage: LogUsage | null): CostBreakdown | null
export function priceFor(providerId: string, upstreamModel: string): Promise<PricingSnapshot | null>
export function clearPriceCache(): void
```

Task 9 calls both. `computeCost` is pure, which is why the arithmetic rules get unit tests rather than database tests.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/pricing.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { clearPriceCache, computeCost, priceFor } from '@/lib/pricing'
import type { LogUsage } from '@/lib/logs/types'
import { resetDb } from '../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearPriceCache()
})

const usage = (over: Partial<LogUsage> = {}): LogUsage => ({
  promptTokens: 1_000_000, completionTokens: 1_000_000,
  cachedTokens: null, reasoningTokens: null, ...over,
})

test('prices a request at the catalog rates', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '3.000000' },
    usage(),
  )
  expect(cost?.inputUsd).toBe('1.000000000')
  expect(cost?.outputUsd).toBe('3.000000000')
  expect(cost?.totalUsd).toBe('4.000000000')
})

test('cached tokens are billed at the cached rate and removed from the input count', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '0' },
    usage({ promptTokens: 1_000_000, cachedTokens: 400_000, completionTokens: 0 }),
  )
  // 600k at full rate + 400k at the cached rate — not 1M at full rate plus a
  // second charge for the cached slice.
  expect(cost?.inputUsd).toBe('0.600000000')
  expect(cost?.cachedUsd).toBe('0.100000000')
  expect(cost?.totalUsd).toBe('0.700000000')
})

test('cached tokens fall back to the input rate when the catalog has no cached price', () => {
  const cost = computeCost(
    { inputPerMtok: '2.000000', cachedInputPerMtok: null, outputPerMtok: '0' },
    usage({ promptTokens: 1_000_000, cachedTokens: 500_000, completionTokens: 0 }),
  )
  expect(cost?.cachedUsd).toBe('1.000000000')
  expect(cost?.totalUsd).toBe('2.000000000')
})

test('a sub-micro-dollar request keeps its value instead of rounding to zero', () => {
  const cost = computeCost(
    { inputPerMtok: '0.100000', cachedInputPerMtok: null, outputPerMtok: '0' },
    usage({ promptTokens: 1, completionTokens: 0 }),
  )
  expect(Number(cost?.totalUsd)).toBeGreaterThan(0)
})

test('no prices means unpriced, not free', () => {
  expect(computeCost(null, usage())).toBeNull()
  expect(computeCost(
    { inputPerMtok: null, cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    usage(),
  )).toBeNull()
})

test('no usage means unpriced', () => {
  expect(computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    null,
  )).toBeNull()
  expect(computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    usage({ promptTokens: null, completionTokens: null }),
  )).toBeNull()
})

test('the snapshot records the rates actually used', () => {
  const prices = { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '3.000000' }
  expect(computeCost(prices, usage())?.pricing).toEqual(prices)
})

test('priceFor reads the catalog by provider and upstream model', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'x' }),
  }).returning()

  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
    inputPerMtok: '0.150000', outputPerMtok: '0.600000',
  })

  expect(await priceFor(provider.id, 'gpt-4o-mini')).toEqual({
    inputPerMtok: '0.150000', cachedInputPerMtok: null, outputPerMtok: '0.600000',
  })
  expect(await priceFor(provider.id, 'not-in-catalog')).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/pricing.test.ts`
Expected: FAIL — cannot resolve `@/lib/pricing`.

- [ ] **Step 3: Implement**

```ts
// src/lib/pricing.ts
import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels } from '@/lib/db/schema'
import type { CostBreakdown, LogUsage, PricingSnapshot } from '@/lib/logs/types'

const SCALE = 9
const PER_MTOK = 1_000_000
/** Prices change monthly at most, and a catalog query per request on the hot
 * path would be a self-inflicted wound. A minute of staleness is the trade. */
const PRICE_TTL_MS = 60_000

const cache = new Map<string, { at: number; prices: PricingSnapshot | null }>()

export function clearPriceCache(): void {
  cache.clear()
}

export async function priceFor(
  providerId: string,
  upstreamModel: string,
): Promise<PricingSnapshot | null> {
  const key = `${providerId}:${upstreamModel}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.prices

  const [row] = await db
    .select({
      inputPerMtok: catalogModels.inputPerMtok,
      cachedInputPerMtok: catalogModels.cachedInputPerMtok,
      outputPerMtok: catalogModels.outputPerMtok,
    })
    .from(catalogModels)
    .where(and(
      eq(catalogModels.providerId, providerId),
      eq(catalogModels.modelId, upstreamModel),
    ))
    .limit(1)

  const prices = row
    ? {
        inputPerMtok: row.inputPerMtok,
        cachedInputPerMtok: row.cachedInputPerMtok,
        outputPerMtok: row.outputPerMtok,
      }
    : null

  cache.set(key, { at: Date.now(), prices })
  return prices
}

function usd(tokens: number, perMtok: string): string {
  // Float arithmetic at nine decimal places: the inputs are token counts and
  // per-million rates, so the products stay far inside the range where a
  // double is exact enough for a displayed cost.
  return ((tokens * Number(perMtok)) / PER_MTOK).toFixed(SCALE)
}

/**
 * Turns catalog rates and measured tokens into a cost.
 *
 * Returns null — never zero — when the request cannot be priced. A dashboard
 * that shows $0.00 for an unpriced model is lying; one that shows "unpriced"
 * is not.
 */
export function computeCost(
  prices: PricingSnapshot | null,
  usage: LogUsage | null,
): CostBreakdown | null {
  if (!prices || !usage) return null
  if (prices.inputPerMtok === null || prices.outputPerMtok === null) return null
  if (usage.promptTokens === null && usage.completionTokens === null) return null

  const cached = usage.cachedTokens ?? 0
  // OpenAI reports cached_tokens as a *subset* of prompt_tokens, so charging
  // both in full would double-count every cached request.
  const billablePrompt = Math.max((usage.promptTokens ?? 0) - cached, 0)
  const cachedRate = prices.cachedInputPerMtok ?? prices.inputPerMtok

  const inputUsd = usd(billablePrompt, prices.inputPerMtok)
  const cachedUsd = cached > 0 ? usd(cached, cachedRate) : null
  const outputUsd = usd(usage.completionTokens ?? 0, prices.outputPerMtok)
  const totalUsd = (Number(inputUsd) + Number(cachedUsd ?? 0) + Number(outputUsd)).toFixed(SCALE)

  return { inputUsd, cachedUsd, outputUsd, totalUsd, pricing: prices }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/pricing.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/pricing.ts tests/lib/pricing.test.ts
git commit -m "feat: price requests from the model catalog"
```

---

### Task 9: Wire the write path

**Files:**
- Create: `src/lib/gateway/usage.ts`, `tests/helpers/logs.ts`
- Modify: `src/lib/gateway/sse.ts:46-130`
- Modify: `src/lib/gateway/chat-handler.ts:73-164`
- Modify: `tests/gateway/stdout-logging.test.ts`
- Test: `tests/gateway/request-logging.test.ts`

**Interfaces:**
- Consumes: `logRequest` (Task 7), `computeCost`/`priceFor` (Task 8), the types (Task 4).
- Produces: `usageFrom(raw)`, and `sseResponse`'s new `onSettle(outcome, capture)` signature plus its `capture` option. Task 10 passes the capture option.

`sseResponse` has exactly one caller (`chat-handler.ts:135`), so the signature change is contained.

- [ ] **Step 1: Write the failing test for database-backed logging**

```ts
// tests/gateway/request-logging.test.ts
import { beforeEach, expect, test, vi } from 'vitest'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { db } from '@/lib/db'
import { catalogModels } from '@/lib/db/schema'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { flushLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 0 },
  },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

test('a successful request lands one row with its winning target', async () => {
  const { apiKey, target } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({
    model: 'house-model', keyName: 'test key', status: 200, outcome: 'ok',
    finalProvider: 'test-provider', finalUpstreamModel: 'gpt-4o-mini',
    promptTokens: 1_000_000, completionTokens: 1_000_000,
  })

  const detail = await postgresStore.get(page.rows[0].requestId)
  expect(detail?.finalTargetId).toBe(target.id)
  expect(detail?.attempts[0]).toMatchObject({ provider: 'test-provider', status: 200 })
})

test('cost is filled in when the catalog prices the winning model', async () => {
  const { apiKey, provider } = await seedGateway()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBeCloseTo(4, 6)
})

test('an unpriced model logs a null cost rather than zero', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  expect((await postgresStore.query({ limit: 1 })).rows[0].costUsd).toBeNull()
})

test('a rejected request logs the error without a key or attempts', async () => {
  await seedGateway()

  await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 401, outcome: 'error', keyName: null })

  const detail = await postgresStore.get(row.requestId)
  expect(detail?.attempts).toEqual([])
  expect(detail?.errorCode).toBe('missing_api_key')
})

test('a streaming request logs usage captured from the final chunk', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ stream: true, outcome: 'ok', promptTokens: 7, completionTokens: 2 })
  expect(row.ttftMs).not.toBeNull()
})

test('a provider that reports no stream usage logs nulls, not zeros', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.promptTokens).toBeNull()
  expect(row.completionTokens).toBeNull()
})

test('a mid-stream failure is logged as stream_interrupted despite the 200', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    }
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ status: 200, outcome: 'stream_interrupted' })
})

test('a write failure never reaches the client', async () => {
  const { apiKey } = await seedGateway()
  const failure = vi.spyOn(postgresStore, 'write').mockRejectedValue(new Error('disk full'))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  expect(res.status).toBe(200)
  expect(stderr).toHaveBeenCalled()
  failure.mockRestore()
  stderr.mockRestore()
})
```

- [ ] **Step 2: Add the flush helper**

```ts
// tests/helpers/logs.ts

/**
 * Waits for a fire-and-forget log write to settle.
 *
 * The handler deliberately does not await logRequest — a log write is not
 * worth client latency — so a test that asserts on the row has to give the
 * write a turn of the event loop.
 */
export async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
```

- [ ] **Step 3: Point the moved stdout test at the stdout store**

`tests/gateway/stdout-logging.test.ts` still asserts on `console.log` lines, but `postgres` is now the default store. Add to its `beforeEach`, after `resetDb()`:

```ts
import { setLoggingSettings } from '@/lib/settings'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { flushLogs } from '../helpers/logs'

// ... inside beforeEach, after resetDb():
await setLoggingSettings({ store: 'stdout' })
clearRequestLogStoreCache()
```

Then add `await flushLogs()` before the assertions in each non-streaming test (`a successful request logs exactly one line`, `the line records every attempt made, in order`, `a failed request still logs its attempts`, `a rejected request with no key logs a null key and no attempts`). The streaming tests already wait via `drain()`; extend its sleep from 10ms to 25ms by calling `await flushLogs()` inside `drain` instead of its inline `setTimeout`.

Leave every assertion unchanged. The stdout line's shape is a contract with existing log parsers.

- [ ] **Step 4: Run both test files to verify they fail**

Run: `pnpm vitest run tests/gateway/request-logging.test.ts tests/gateway/stdout-logging.test.ts`
Expected: FAIL — `chat-handler.ts` still imports the deleted `./request-log`.

- [ ] **Step 5: Add the usage extractor**

```ts
// src/lib/gateway/usage.ts
import type { LogUsage } from '@/lib/logs/types'

interface RawUsage {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
  completion_tokens_details?: { reasoning_tokens?: number | null } | null
}

function count(value: number | null | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * Normalizes an upstream `usage` object.
 *
 * Returns null when the provider reported nothing — a provider configured
 * with disableStreamUsage, or one whose clone omits the field. Absent counts
 * stay null rather than becoming 0: "we did not measure it" and "it was free"
 * must not render identically.
 */
export function usageFrom(raw: RawUsage | null | undefined): LogUsage | null {
  if (!raw) return null
  return {
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    cachedTokens: count(raw.prompt_tokens_details?.cached_tokens),
    reasoningTokens: count(raw.completion_tokens_details?.reasoning_tokens),
  }
}
```

- [ ] **Step 6: Teach `sse.ts` to capture**

In `src/lib/gateway/sse.ts`, add the import and the capture type, and change `sseResponse`:

```ts
import type { LogUsage } from '@/lib/logs/types'
import { usageFrom } from './usage'

export interface StreamCapture {
  usage: LogUsage | null
  /** Assembled assistant text. Empty unless payload capture was requested. */
  text: string
  /** True once the text hit the byte cap and stopped accumulating. */
  truncated: boolean
}

export interface CaptureOptions {
  /** Accumulate assistant text up to this many bytes, for payload capture. */
  maxBytes: number
}

export function sseResponse(
  started: StartedChatStream,
  identity: IdentityOptions,
  headers: HeadersInit,
  onSettle?: (outcome: StreamOutcome, capture: StreamCapture) => void,
  capture?: CaptureOptions,
): Response {
  let cancelled = false
  let settled = false

  // Accumulated as the stream is relayed, so the settle callback — whichever
  // of the three paths reaches it — reports what actually got through.
  const captured: StreamCapture = { usage: null, text: '', truncated: false }

  function settle(outcome: StreamOutcome) {
    if (settled) return
    settled = true
    try {
      onSettle?.(outcome, captured)
    } catch (err) {
      console.error('[gateway] stream settle callback failed', err)
    }
  }
```

Inside the `for await` loop in `start()`, before the `controller.enqueue` call:

```ts
        for await (const chunk of started.chunks) {
          if (cancelled) return
          // include_usage puts this on the final chunk; a provider that omits
          // it simply leaves captured.usage null.
          if (chunk.usage) captured.usage = usageFrom(chunk.usage)
          if (capture && !captured.truncated) accumulate(captured, chunk, capture.maxBytes)
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
```

And add the helper below `event()`:

```ts
/** Assembles assistant text for payload capture, stopping at the byte cap.
 * Only runs when capture was requested, so streams for keys without payload
 * logging pay nothing. */
function accumulate(captured: StreamCapture, chunk: ChatCompletionChunk, maxBytes: number) {
  const delta = chunk.choices?.[0]?.delta?.content
  if (!delta) return
  if (Buffer.byteLength(captured.text, 'utf8') + Buffer.byteLength(delta, 'utf8') > maxBytes) {
    captured.truncated = true
    return
  }
  captured.text += delta
}
```

Everything else in `sse.ts` — the `cancelled` guard, the first-one-wins `settle`, the `cancel()` cleanup — stays exactly as it is.

- [ ] **Step 7: Rewrite the logging half of `chat-handler.ts`**

Replace the `emitRequestLog` import with:

```ts
import { logRequest } from '@/lib/logs'
import type { LogPayload, LogUsage, RequestOutcome } from '@/lib/logs/types'
import { computeCost, priceFor } from '@/lib/pricing'
import { usageFrom } from './usage'
```

Replace the `log()` closure (currently `chat-handler.ts:87-105`) with:

```ts
  let keyId: string | null = null
  let keyName: string | null = null
  let modelName: string | null = null
  let stream = false
  let dropped: string[] = []

  interface LogExtra {
    ttftMs?: number
    /** The target that actually served, which is what gets priced. */
    candidate?: Candidate
    usage?: LogUsage | null
    payload?: LogPayload | null
    error?: unknown
  }

  function log(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra = {},
  ) {
    // Fire-and-forget. A request that succeeded must not be failed — or even
    // slowed — by its own bookkeeping.
    void writeLog(status, outcome, attempts, extra).catch((err) =>
      console.error(`[gateway] failed to write request log request_id=${requestId}`, err),
    )
  }

  async function writeLog(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra,
  ) {
    const usage = extra.usage ?? null
    const cost =
      extra.candidate && usage
        ? computeCost(
            await priceFor(extra.candidate.provider.id, extra.candidate.upstreamModel),
            usage,
          )
        : null

    await logRequest({
      requestId,
      keyId,
      keyName,
      model: modelName,
      stream,
      status,
      outcome,
      ...errorFields(extra.error),
      latencyMs: Date.now() - startedAt,
      ...(extra.ttftMs === undefined ? {} : { ttftMs: extra.ttftMs }),
      attempts,
      final: extra.candidate
        ? {
            targetId: extra.candidate.targetId,
            providerId: extra.candidate.provider.id,
            provider: extra.candidate.provider.name,
            upstreamModel: extra.candidate.upstreamModel,
          }
        : null,
      usage,
      cost,
      ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
      payload: extra.payload ?? null,
    })
  }
```

Add above `handleChatCompletions`:

```ts
/** The log keeps the real message even for an unhandled error: the page that
 * reads it is admin-only, and the sanitized envelope the client received is
 * useless for diagnosis. */
function errorFields(err: unknown) {
  if (err === undefined) return {}
  if (err instanceof GatewayError) {
    return { errorType: err.type, errorCode: err.code, errorMessage: err.message }
  }
  return {
    errorType: 'internal_error',
    errorCode: null,
    errorMessage: err instanceof Error ? err.message : String(err),
  }
}
```

Update the three call sites:

```ts
    const apiKey = await resolveApiKey(extractBearerToken(request))
    keyId = apiKey.id
    keyName = apiKey.name
```

```ts
      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId, dropped),
        (outcome, capture) =>
          log(200, outcome, result.attempts, {
            ttftMs,
            candidate: result.candidate,
            usage: capture.usage,
          }),
      )
```

```ts
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage: usageFrom(result.value.usage),
    })
    return Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId, dropped),
    })
```

```ts
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500
    log(status, 'error', err instanceof RoutedError ? err.attempts : [], { error: err })
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `pnpm vitest run tests/gateway/request-logging.test.ts tests/gateway/stdout-logging.test.ts`
Expected: PASS — 8 new tests plus the 7 preserved stdout tests.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm test`
Expected: every file passes. This is the first point since Task 4 where the tree is coherent, so a failure here is a real regression — investigate rather than skip.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/gateway tests/gateway tests/helpers/logs.ts
git commit -m "feat: write request logs to the configured store with usage and cost"
```

---

### Task 10: Payload capture

**Files:**
- Modify: `src/lib/gateway/chat-handler.ts`
- Test: `tests/gateway/payload-capture.test.ts`

**Interfaces:**
- Consumes: `capPayload` (Task 5), `resolveRequestLogStore` (Task 7), the `capture` option on `sseResponse` (Task 9).
- Produces: nothing new. This task only fills `entry.payload`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/payload-capture.test.ts
import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { setLoggingSettings } from '@/lib/settings'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { flushLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
})

async function seedWithCapture(logPayloads: boolean) {
  const seeded = await seedGateway()
  await db.update(apiKeys).set({ logPayloads }).where(eq(apiKeys.id, seeded.key.id))
  return seeded
}

test('a key with payload logging off stores no payload', async () => {
  const { apiKey } = await seedWithCapture(false)

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(false)
  expect((await postgresStore.get(row.requestId))?.payload).toBeNull()
})

test('a key with payload logging on stores what the client sent and received', async () => {
  const { apiKey } = await seedWithCapture(true)

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(true)

  const detail = await postgresStore.get(row.requestId)
  expect(detail?.payload?.request).toMatchObject({ model: 'house-model' })
  // The rewritten completion — what the client actually received — not the
  // upstream one.
  const response = detail?.payload?.response as { model: string; choices: unknown[] }
  expect(response.model).toBe('house-model')
  expect(response.choices).toHaveLength(1)
})

test('a streaming response is assembled from its deltas', async () => {
  const { apiKey } = await seedWithCapture(true)
  const chatStream = async function* () {
    for (const content of ['Hel', 'lo ', 'world']) {
      yield {
        id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.requestId)
  const response = detail?.payload?.response as {
    choices: Array<{ message: { content: string } }>
  }
  expect(response.choices[0].message.content).toBe('Hello world')
})

test('an oversized payload is replaced by the truncation envelope', async () => {
  const { apiKey } = await seedWithCapture(true)
  await setLoggingSettings({ payloadMaxBytes: 64 })
  clearRequestLogStoreCache()

  const long = { ...body, messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  await handleChatCompletions(
    chatRequest(long, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.requestId)
  expect(detail?.payload?.truncated).toBe(true)
  expect(detail?.payload?.request).toMatchObject({ truncated: true })
})

test('a request that fails before parsing records no payload', async () => {
  await seedWithCapture(true)

  const malformed = new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  await handleChatCompletions(malformed, fakeAdapterDeps({}))
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/gateway/payload-capture.test.ts`
Expected: FAIL — payloads are never captured, so the second test finds `payloadCaptured: false`.

- [ ] **Step 3: Implement in `chat-handler.ts`**

Add the imports:

```ts
import { resolveRequestLogStore } from '@/lib/logs'
import { capPayload } from '@/lib/logs/payload'
```

Add two tracked variables beside `keyId` / `keyName`:

```ts
  // Payload capture is per key and off by default, so the cost of assembling
  // and storing bodies falls only on the keys that asked for it.
  let capturePayloads = false
  let requestBody: ChatCompletionRequest | null = null
```

Set them where the key and body become known:

```ts
    const apiKey = await resolveApiKey(extractBearerToken(request))
    keyId = apiKey.id
    keyName = apiKey.name
    capturePayloads = apiKey.logPayloads
    const body = await parseBody(request)
    requestBody = body
```

Add the payload builder above `handleChatCompletions`:

```ts
/**
 * Bounds and packages a request/response pair for storage.
 *
 * Capping happens here, before the write, so the store's insert can be a
 * single transaction whose only remaining failure mode is the database
 * itself.
 */
function buildPayload(
  request: unknown,
  response: unknown,
  maxBytes: number,
  truncatedUpstream = false,
): LogPayload {
  const cappedRequest = capPayload(request, maxBytes)
  const cappedResponse = capPayload(response, maxBytes)
  return {
    request: cappedRequest.value,
    response: cappedResponse.value,
    truncated: truncatedUpstream || cappedRequest.truncated || cappedResponse.truncated,
  }
}
```

In `writeLog`, resolve the cap from the same cached settings bundle the store came from — one call, no extra query:

```ts
  async function writeLog(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra,
  ) {
    const usage = extra.usage ?? null
    const cost = /* unchanged */
    const { settings } = await resolveRequestLogStore()

    const payload =
      capturePayloads && requestBody
        ? buildPayload(
            requestBody,
            extra.response ?? null,
            settings.payloadMaxBytes,
            extra.responseTruncated ?? false,
          )
        : null

    await logRequest({ /* unchanged, with */ payload })
  }
```

Extend `LogExtra` with the two response fields and drop the old `payload` field:

```ts
  interface LogExtra {
    ttftMs?: number
    candidate?: Candidate
    usage?: LogUsage | null
    /** What the client received, for payload capture. */
    response?: unknown
    responseTruncated?: boolean
    error?: unknown
  }
```

Non-streaming — pass the rewritten completion, which is what the client actually got:

```ts
    const completion = rewriteCompletion(result.value, identity)
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage: usageFrom(result.value.usage),
      response: completion,
    })
    return Response.json(completion, {
      headers: attemptHeaders(result.candidate, requestId, dropped),
    })
```

Streaming — request the capture and assemble a synthetic completion from the accumulated text. Raw chunk arrays are storage-hungry and nobody reads them:

```ts
      const { settings } = await resolveRequestLogStore()

      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId, dropped),
        (outcome, capture) =>
          log(200, outcome, result.attempts, {
            ttftMs,
            candidate: result.candidate,
            usage: capture.usage,
            response: capturePayloads
              ? {
                  id: identity.id,
                  object: 'chat.completion',
                  model: identity.model,
                  choices: [{
                    index: 0,
                    message: { role: 'assistant', content: capture.text },
                    finish_reason: outcome === 'ok' ? 'stop' : null,
                  }],
                }
              : null,
            responseTruncated: capture.truncated,
          }),
        capturePayloads ? { maxBytes: settings.payloadMaxBytes } : undefined,
      )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/gateway/payload-capture.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite, then typecheck, lint, commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add src/lib/gateway/chat-handler.ts tests/gateway/payload-capture.test.ts
git commit -m "feat: capture request and response payloads for opted-in keys"
```

---

> **Note on the UI tasks (11–14).** This repo has no React testing library and
> the global constraints forbid adding one. UI tasks are verified with
> `pnpm typecheck`, `pnpm lint`, `pnpm build`, and a named manual check. Their
> data layers are plain functions and DO get tests.

### Task 11: Grouped navigation

**Files:**
- Modify: `src/app/(admin)/layout.tsx:5-32`

**Interfaces:**
- Consumes: the existing `NavLink`, which does not change.
- Produces: routes `/logs` and `/settings` in the sidebar. Tasks 12 and 14 fill them in.

- [ ] **Step 1: Restructure `NAV` into sections**

```tsx
interface NavItem {
  href: string
  label: string
}

interface NavSection {
  /** Rendered as a small heading above the group. Absent for the first,
   * unlabeled group. */
  label?: string
  items: NavItem[]
}

const NAV: NavSection[] = [
  {
    items: [
      { href: '/providers', label: 'Providers' },
      { href: '/catalog', label: 'Catalog' },
      { href: '/models', label: 'Virtual models' },
      { href: '/keys', label: 'API keys' },
      { href: '/users', label: 'Users' },
    ],
  },
  {
    label: 'Governance',
    items: [{ href: '/logs', label: 'Request logs' }],
  },
]

/** Settings is not part of Governance: it will hold settings for every area of
 * the app, with Governance as one tab inside it. */
const FOOTER_NAV: NavItem[] = [{ href: '/settings', label: 'Settings' }]
```

- [ ] **Step 2: Render the sections**

```tsx
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {NAV.map((section, index) => (
            <div key={section.label ?? index} className="flex flex-col gap-1">
              {section.label ? (
                <div className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {section.label}
                </div>
              ) : null}
              {section.items.map((item) => (
                <NavLink key={item.href} href={item.href} label={item.label} />
              ))}
            </div>
          ))}

          <div className="mt-auto flex flex-col gap-1 pt-4">
            {FOOTER_NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </div>
        </nav>
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

Manual check: `pnpm dev`, open any admin page, confirm a GOVERNANCE heading sits above "Request logs" and "Settings" is pinned at the bottom. Both links 404 until Tasks 12 and 14 — that is expected at this point.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/layout.tsx"
git commit -m "feat: group the admin sidebar and add a Governance section"
```

---

### Task 12: The Request Logs page

**Files:**
- Create: `src/lib/admin/logs.ts`, `src/app/(admin)/logs/page.tsx`, `src/app/(admin)/logs/log-filters.tsx`
- Test: `tests/lib/admin/logs.test.ts`

**Interfaces:**
- Consumes: `resolveRequestLogStore` (Task 7), `LogFilter`/`LogPage` (Task 4).
- Produces:

```ts
export const LOG_PAGE_SIZE = 50
export interface LogSearchParams { range?: string; key?: string; model?: string; status?: string; after?: string; before?: string }
export function parseLogFilter(params: LogSearchParams, now?: Date): LogFilter
export interface LogsView { readable: boolean; storeName: string; configured: string; fallback: 'unknown_driver' | 'settings_error' | null; page: LogPage | null }
export function loadLogs(filter: LogFilter): Promise<LogsView>
```

Task 13 reuses `loadLogDetail` added here.

- [ ] **Step 1: Write the failing test for filter parsing**

```ts
// tests/lib/admin/logs.test.ts
import { beforeEach, expect, test } from 'vitest'
import { LOG_PAGE_SIZE, loadLogs, parseLogFilter } from '@/lib/admin/logs'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { postgresStore } from '@/lib/logs/postgres'
import { setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../../helpers/db'

const NOW = new Date('2026-08-13T12:00:00.000Z')

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

test('defaults to the last 24 hours and one page', () => {
  const filter = parseLogFilter({}, NOW)
  expect(filter.limit).toBe(LOG_PAGE_SIZE)
  expect(filter.from).toEqual(new Date('2026-08-12T12:00:00.000Z'))
  expect(filter.to).toBeUndefined()
})

test('understands every range option, including all', () => {
  expect(parseLogFilter({ range: '1h' }, NOW).from).toEqual(new Date('2026-08-13T11:00:00.000Z'))
  expect(parseLogFilter({ range: '7d' }, NOW).from).toEqual(new Date('2026-08-06T12:00:00.000Z'))
  expect(parseLogFilter({ range: '30d' }, NOW).from).toEqual(new Date('2026-07-14T12:00:00.000Z'))
  expect(parseLogFilter({ range: 'all' }, NOW).from).toBeUndefined()
})

test('an unrecognized range falls back to the default rather than throwing', () => {
  expect(parseLogFilter({ range: 'nonsense' }, NOW).from)
    .toEqual(new Date('2026-08-12T12:00:00.000Z'))
})

test('maps the single status select onto a class or an outcome', () => {
  expect(parseLogFilter({ status: 'success' }, NOW).statusClass).toBe('success')
  expect(parseLogFilter({ status: 'server_error' }, NOW).statusClass).toBe('server_error')
  expect(parseLogFilter({ status: 'stream_interrupted' }, NOW).outcome).toBe('stream_interrupted')
  expect(parseLogFilter({ status: 'client_closed' }, NOW).outcome).toBe('client_closed')
  expect(parseLogFilter({ status: 'all' }, NOW).statusClass).toBeUndefined()
})

test('passes through key, model and cursors', () => {
  const filter = parseLogFilter(
    { key: 'k-1', model: 'house-model', after: 'cursor-1' },
    NOW,
  )
  expect(filter).toMatchObject({ apiKeyId: 'k-1', model: 'house-model', after: 'cursor-1' })
})

test('drops a blank model rather than filtering on an empty string', () => {
  expect(parseLogFilter({ model: '   ' }, NOW).model).toBeUndefined()
})

test('loadLogs reports a readable store and its page', async () => {
  await postgresStore.write({
    requestId: 'req_x', keyId: null, keyName: null, model: 'm',
    stream: false, status: 200, outcome: 'ok', latencyMs: 1, attempts: [],
  })

  const view = await loadLogs(parseLogFilter({ range: 'all' }))
  expect(view.readable).toBe(true)
  expect(view.storeName).toBe('postgres')
  expect(view.page?.rows).toHaveLength(1)
})

test('loadLogs reports an unreadable store with no page instead of throwing', async () => {
  await setLoggingSettings({ store: 'stdout' })
  clearRequestLogStoreCache()

  const view = await loadLogs(parseLogFilter({}))
  expect(view.readable).toBe(false)
  expect(view.storeName).toBe('stdout')
  expect(view.page).toBeNull()
})

test('loadLogs surfaces an unknown configured driver', async () => {
  await setLoggingSettings({ store: 'clickhouse' })
  clearRequestLogStoreCache()

  const view = await loadLogs(parseLogFilter({}))
  expect(view.fallback).toBe('unknown_driver')
  expect(view.configured).toBe('clickhouse')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/admin/logs.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/logs`.

- [ ] **Step 3: Implement the read layer**

```ts
// src/lib/admin/logs.ts
import 'server-only'
import { resolveRequestLogStore } from '@/lib/logs'
import type { LogDetail, LogFilter, LogPage, StatusClass } from '@/lib/logs/types'

export const LOG_PAGE_SIZE = 50

const RANGES: Record<string, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  // null means no lower bound at all.
  all: null,
}

export const DEFAULT_RANGE = '24h'

const STATUS_CLASSES: StatusClass[] = ['success', 'client_error', 'server_error']

export interface LogSearchParams {
  range?: string
  key?: string
  model?: string
  status?: string
  after?: string
  before?: string
}

/**
 * Turns URL search params into a store filter.
 *
 * Every unrecognized value degrades to the default rather than throwing: a
 * hand-edited URL should show the default view, not an error page.
 */
export function parseLogFilter(
  params: LogSearchParams,
  now: Date = new Date(),
): LogFilter {
  const range = params.range && params.range in RANGES ? params.range : DEFAULT_RANGE
  const window = RANGES[range]
  const model = params.model?.trim()
  const status = params.status

  return {
    ...(window === null ? {} : { from: new Date(now.getTime() - window) }),
    ...(params.key ? { apiKeyId: params.key } : {}),
    ...(model ? { model } : {}),
    ...(status && STATUS_CLASSES.includes(status as StatusClass)
      ? { statusClass: status as StatusClass }
      : {}),
    ...(status === 'stream_interrupted' || status === 'client_closed'
      ? { outcome: status }
      : {}),
    ...(params.after ? { after: params.after } : {}),
    ...(params.before ? { before: params.before } : {}),
    limit: LOG_PAGE_SIZE,
  }
}

export interface LogsView {
  readable: boolean
  storeName: string
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  page: LogPage | null
}

export async function loadLogs(filter: LogFilter): Promise<LogsView> {
  const { store, configured, fallback } = await resolveRequestLogStore()
  // Narrowing on the discriminant, so an unreadable store is a branch here
  // rather than a query() that throws in production.
  const page = store.readable ? await store.query(filter) : null
  return { readable: store.readable, storeName: store.name, configured, fallback, page }
}

export async function loadLogDetail(requestId: string): Promise<LogDetail | null> {
  const { store } = await resolveRequestLogStore()
  return store.readable ? store.get(requestId) : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/admin/logs.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Build the filter bar**

```tsx
// src/app/(admin)/logs/log-filters.tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const RANGES = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
]

const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: 'success', label: 'Success' },
  { value: 'client_error', label: 'Client error' },
  { value: 'server_error', label: 'Server error' },
  { value: 'stream_interrupted', label: 'Stream interrupted' },
  { value: 'client_closed', label: 'Client closed' },
]

export function LogFilters({
  keys,
  models,
}: {
  keys: Array<{ id: string; name: string }>
  models: string[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [requestId, setRequestId] = useState('')

  // Every change resets the cursors: a filter change makes the old keyset
  // position meaningless.
  function apply(name: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value === 'all' && name !== 'status') next.delete(name)
    else if (!value) next.delete(name)
    else next.set(name, value)
    next.delete('after')
    next.delete('before')
    router.push(`/logs?${next.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={params.get('range') ?? '24h'} onValueChange={(v) => apply('range', v)}>
        <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('key') ?? 'all'} onValueChange={(v) => apply('key', v)}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Any key" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any key</SelectItem>
          {keys.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('model') ?? 'all'} onValueChange={(v) => apply('model', v)}>
        <SelectTrigger className="w-52"><SelectValue placeholder="Any model" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any model</SelectItem>
          {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('status') ?? 'all'} onValueChange={(v) => apply('status', v)}>
        <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <form
        className="ml-auto flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const id = requestId.trim()
          if (id) router.push(`/logs/${encodeURIComponent(id)}`)
        }}
      >
        <Input
          value={requestId}
          onChange={(event) => setRequestId(event.target.value)}
          placeholder="req_…"
          className="w-48 font-mono text-xs"
          aria-label="Look up a request id"
        />
        <Button type="submit" variant="secondary">Find</Button>
      </form>
    </div>
  )
}
```

The model select is seeded from virtual model names. A direct `provider/model`
route that has never been given a virtual model will not appear in the list;
it is still reachable by editing the `model` query parameter, and the request-id
lookup covers the case people actually hit.

- [ ] **Step 6: Build the page**

```tsx
// src/app/(admin)/logs/page.tsx
import Link from 'next/link'
import { asc } from 'drizzle-orm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { db } from '@/lib/db'
import { virtualModels } from '@/lib/db/schema'
import { listApiKeys } from '@/lib/admin/keys'
import { loadLogs, parseLogFilter, type LogSearchParams } from '@/lib/admin/logs'
import { requireAdmin } from '@/lib/admin/session'
import { LogFilters } from './log-filters'

export const dynamic = 'force-dynamic'

function statusVariant(status: number) {
  if (status >= 500) return 'destructive' as const
  if (status >= 400) return 'secondary' as const
  return 'default' as const
}

function cost(value: string | null) {
  // A null cost is not a free request — it is a request the catalog could not
  // price. Saying "unpriced" is the whole reason the column is nullable.
  return value === null ? 'unpriced' : `$${Number(value).toFixed(6)}`
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<LogSearchParams>
}) {
  await requireAdmin()
  const params = await searchParams
  const filter = parseLogFilter(params)

  const [view, keys, models] = await Promise.all([
    loadLogs(filter),
    listApiKeys(),
    db.select({ name: virtualModels.name }).from(virtualModels).orderBy(asc(virtualModels.name)),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Request logs"
        description="Every request the gateway has served, from the configured log store."
      />

      {view.fallback === 'unknown_driver' ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          No log driver named <span className="font-mono">{view.configured}</span> is
          registered in this build, so logging has fallen back to stdout. Pick a
          driver on the <Link className="underline" href="/settings">Settings</Link> page.
        </div>
      ) : null}

      {view.storeName === 'postgres' ? (
        <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Logs are stored in this gateway&apos;s own PostgreSQL database. That is the
          right choice for development and low traffic, but at high request rates this
          table and its indexes will compete with the queries that serve requests.
          Switch stores on the <Link className="underline" href="/settings">Settings</Link> page
          before that day arrives.
        </div>
      ) : null}

      {!view.readable ? (
        <div className="space-y-2 rounded-md border px-4 py-8 text-center">
          <p className="font-medium">
            The <span className="font-mono">{view.storeName}</span> store cannot be read back.
          </p>
          <p className="text-sm text-muted-foreground">
            Requests are still being logged — one JSON line per request, on the
            container&apos;s stdout. Read them with{' '}
            <span className="font-mono">docker compose logs -f gateway</span> and search by
            the <span className="font-mono">x-request-id</span> header the gateway returns.
          </p>
        </div>
      ) : (
        <>
          <LogFilters keys={keys} models={models.map((m) => m.name)} />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.page?.rows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer">
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/logs/${row.requestId}`} className="hover:underline">
                      {row.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                    </Link>
                  </TableCell>
                  <TableCell>{row.keyName ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{row.model ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{row.finalProvider ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    {row.outcome === 'ok' ? null : (
                      <span className="ml-2 text-xs text-muted-foreground">{row.outcome}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.latencyMs} ms</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.promptTokens === null && row.completionTokens === null
                      ? '—'
                      : `${row.promptTokens ?? 0} / ${row.completionTokens ?? 0}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cost(row.costUsd)}</TableCell>
                </TableRow>
              ))}
              {view.page && view.page.rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    No requests match these filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="flex justify-end gap-2">
            <Button asChild variant="secondary" disabled={!view.page?.prevCursor}>
              <Link href={`/logs?${cursorParams(params, 'before', view.page?.prevCursor)}`}>
                Newer
              </Link>
            </Button>
            <Button asChild variant="secondary" disabled={!view.page?.nextCursor}>
              <Link href={`/logs?${cursorParams(params, 'after', view.page?.nextCursor)}`}>
                Older
              </Link>
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/** Keeps the active filters and swaps only the cursor, so paging does not
 * silently widen the query. */
function cursorParams(
  params: LogSearchParams,
  name: 'after' | 'before',
  cursor: string | null | undefined,
): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== 'after' && key !== 'before') next.set(key, value)
  }
  if (cursor) next.set(name, cursor)
  return next.toString()
}
```

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean build.

Manual check: `pnpm dev`, send a request through `/v1/chat/completions`, open `/logs`, confirm the row appears, the Postgres warning banner shows, and changing a filter updates the URL and the rows.

- [ ] **Step 8: Commit**

```bash
git add src/lib/admin/logs.ts "src/app/(admin)/logs" tests/lib/admin/logs.test.ts
git commit -m "feat: add the Request Logs page with filters and keyset paging"
```

---

### Task 13: The request detail page

**Files:**
- Create: `src/app/(admin)/logs/[requestId]/page.tsx`

**Interfaces:**
- Consumes: `loadLogDetail` (Task 12).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Build the page**

```tsx
// src/app/(admin)/logs/[requestId]/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { loadLogDetail } from '@/lib/admin/logs'
import { requireAdmin } from '@/lib/admin/session'

export const dynamic = 'force-dynamic'

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}

function money(value: string | null) {
  return value === null ? 'unpriced' : `$${Number(value).toFixed(9)}`
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="w-full px-4 py-3 text-left text-sm font-medium">
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-96 overflow-auto border-t px-4 py-3 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export default async function LogDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>
}) {
  await requireAdmin()
  const { requestId } = await params
  const log = await loadLogDetail(decodeURIComponent(requestId))
  if (!log) notFound()

  return (
    <div className="space-y-6">
      <PageHeader
        title={log.requestId}
        description={`${log.createdAt.toISOString().replace('T', ' ').slice(0, 19)} · ${log.model ?? 'unknown model'}`}
        action={<Link href="/logs" className="text-sm underline">Back to logs</Link>}
      />

      <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
        <Field
          label="Status"
          value={
            <span className="flex items-center gap-2">
              <Badge variant={log.status >= 500 ? 'destructive' : log.status >= 400 ? 'secondary' : 'default'}>
                {log.status}
              </Badge>
              <span className="text-muted-foreground">{log.outcome}</span>
            </span>
          }
        />
        <Field label="Key" value={log.keyName ?? '—'} />
        <Field label="Served by" value={log.finalProvider ? `${log.finalProvider} · ${log.finalUpstreamModel}` : '—'} />
        <Field label="Streaming" value={log.stream ? 'yes' : 'no'} />
        <Field label="Latency" value={`${log.latencyMs} ms`} />
        <Field label="Time to first token" value={log.ttftMs === null ? '—' : `${log.ttftMs} ms`} />
        <Field
          label="Tokens"
          value={
            log.promptTokens === null && log.completionTokens === null
              ? 'not reported'
              : `${log.promptTokens ?? 0} in / ${log.completionTokens ?? 0} out` +
                (log.cachedTokens ? ` · ${log.cachedTokens} cached` : '') +
                (log.reasoningTokens ? ` · ${log.reasoningTokens} reasoning` : '')
          }
        />
        <Field label="Total cost" value={money(log.costUsd)} />
      </div>

      {log.errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <div className="font-medium">{log.errorType}{log.errorCode ? ` · ${log.errorCode}` : ''}</div>
          <div className="text-muted-foreground">{log.errorMessage}</div>
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Attempts</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Upstream model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.attempts.map((attempt) => (
              <TableRow key={attempt.n}>
                <TableCell>{attempt.n}</TableCell>
                <TableCell>{attempt.provider}</TableCell>
                <TableCell className="font-mono text-xs">{attempt.model}</TableCell>
                <TableCell>{attempt.status}</TableCell>
                <TableCell className="text-right tabular-nums">{attempt.latencyMs} ms</TableCell>
                <TableCell className="text-xs text-muted-foreground">{attempt.error ?? '—'}</TableCell>
              </TableRow>
            ))}
            {log.attempts.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  The request failed before any target was tried.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Cost breakdown</h2>
        <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
          <Field label="Input" value={money(log.inputCostUsd)} />
          <Field label="Cached input" value={money(log.cachedCostUsd)} />
          <Field label="Output" value={money(log.outputCostUsd)} />
          <Field label="Total" value={money(log.costUsd)} />
        </div>
        {log.pricing ? (
          <p className="text-xs text-muted-foreground">
            Rates used, per million tokens: input {log.pricing.inputPerMtok ?? '—'}, cached{' '}
            {log.pricing.cachedInputPerMtok ?? 'same as input'}, output{' '}
            {log.pricing.outputPerMtok ?? '—'}. Snapshotted at request time, so later
            catalog edits do not change this row.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The catalog had no price for this provider and model, so this request is
            unpriced rather than free.
          </p>
        )}
      </section>

      {log.droppedParams?.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Dropped parameters</h2>
          <p className="text-sm text-muted-foreground">
            The winning target&apos;s protocol could not express: {log.droppedParams.join(', ')}.
          </p>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Payloads</h2>
        {log.payload ? (
          <div className="space-y-2">
            {log.payload.truncated ? (
              <p className="text-xs text-muted-foreground">
                This payload exceeded the configured size cap and was stored as a
                truncated preview.
              </p>
            ) : null}
            <Json label="Request" value={log.payload.request} />
            <Json label="Response" value={log.payload.response} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {log.payloadCaptured
              ? 'This request was captured, but its payload row is no longer present.'
              : 'Payload capture is off for this API key. Turn it on per key on the API keys page.'}
          </p>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

Manual check: `pnpm dev`, click a row on `/logs`. Confirm the attempt timeline renders, an unpriced request says "unpriced" rather than `$0.00`, and a key with payload capture off shows the explanatory line instead of empty blocks. Visit `/logs/req_nonexistent` and confirm a 404.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(admin)/logs/[requestId]"
git commit -m "feat: add the request detail page with the attempt timeline"
```

---

### Task 14: The Settings page and its Governance tab

**Files:**
- Create: `src/app/(admin)/settings/page.tsx`, `src/app/(admin)/settings/governance-form.tsx`, `src/app/(admin)/settings/actions.ts`
- Add: `src/components/ui/tabs.tsx` via shadcn

**Interfaces:**
- Consumes: `getLoggingSettings`/`setLoggingSettings` (Task 3), `DRIVERS`, `resolveRequestLogStore`, `clearRequestLogStoreCache` (Task 7).
- Produces: nothing later tasks depend on.

The action follows the `ActionState` + `revalidatePath` pattern already used by
`saveRegistrySettingsAction` in `src/app/(admin)/catalog/actions.ts:154`.

- [ ] **Step 1: Install the tabs component**

Run: `pnpm dlx shadcn@latest add tabs`
Expected: creates `src/components/ui/tabs.tsx`. This is the only new component the plan adds; everything else composes from what is installed.

- [ ] **Step 2: Write the server action**

```ts
// src/app/(admin)/settings/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import { clearRequestLogStoreCache } from '@/lib/logs'
import { setLoggingSettings } from '@/lib/settings'

export interface ActionState {
  error?: string
  success?: string
}

export async function saveLoggingSettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setLoggingSettings({
      store: String(formData.get('store') ?? ''),
      retentionDays: Number(formData.get('retentionDays')),
      payloadMaxBytes: Number(formData.get('payloadMaxBytes')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }

  // This instance can stop serving the old store immediately. Other instances
  // pick the change up when their own cache expires.
  clearRequestLogStoreCache()
  revalidatePath('/settings')
  revalidatePath('/logs')
  return { success: 'Logging settings saved.' }
}
```

- [ ] **Step 3: Write the Governance form**

```tsx
// src/app/(admin)/settings/governance-form.tsx
'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { saveLoggingSettingsAction, type ActionState } from './actions'

export function GovernanceForm({
  drivers,
  store,
  retentionDays,
  payloadMaxBytes,
  activeStore,
  ttlSeconds,
}: {
  drivers: Array<{ name: string; readable: boolean }>
  store: string
  retentionDays: number
  payloadMaxBytes: number
  activeStore: string
  ttlSeconds: number
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    saveLoggingSettingsAction,
    undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <form action={action} className="max-w-xl space-y-6">
      <div className="space-y-2">
        <Label htmlFor="store">Request log store</Label>
        <Select name="store" defaultValue={store}>
          <SelectTrigger id="store"><SelectValue /></SelectTrigger>
          <SelectContent>
            {drivers.map((driver) => (
              <SelectItem key={driver.name} value={driver.name}>
                {driver.name}{driver.readable ? '' : ' — write only'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Switching stores does not move existing logs. The previous store keeps its
          rows; this page and the log viewer show the new store only, and switching
          back brings the old rows back into view. Other running instances pick up a
          change within {ttlSeconds} seconds.
        </p>
        {activeStore !== store ? (
          <p className="text-xs text-destructive">
            Currently logging to <span className="font-mono">{activeStore}</span>, because
            the configured store could not be used.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="retentionDays">Retention (days)</Label>
        <Input
          id="retentionDays" name="retentionDays" type="number" min={0}
          defaultValue={retentionDays}
        />
        <p className="text-xs text-muted-foreground">
          Logs older than this are deleted hourly. Set 0 to keep everything, which
          means you are responsible for the table&apos;s growth.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="payloadMaxBytes">Payload size cap (bytes)</Label>
        <Input
          id="payloadMaxBytes" name="payloadMaxBytes" type="number" min={1}
          defaultValue={payloadMaxBytes}
        />
        <p className="text-xs text-muted-foreground">
          Applies to keys with payload logging enabled. Anything larger is stored as a
          truncated preview.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 4: Write the page**

```tsx
// src/app/(admin)/settings/page.tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/admin/page-header'
import { requireAdmin } from '@/lib/admin/session'
import { DRIVERS, LOG_SETTINGS_TTL_MS, resolveRequestLogStore } from '@/lib/logs'
import { getLoggingSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, resolved] = await Promise.all([
    getLoggingSettings(),
    resolveRequestLogStore(),
  ])

  const drivers = Object.values(DRIVERS).map((driver) => ({
    name: driver.name,
    readable: driver.readable,
  }))

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Gateway-wide configuration." />

      <Tabs defaultValue="governance">
        <TabsList>
          <TabsTrigger value="governance">Governance</TabsTrigger>
        </TabsList>
        <TabsContent value="governance" className="pt-6">
          <GovernanceForm
            drivers={drivers}
            store={settings.store}
            retentionDays={settings.retentionDays}
            payloadMaxBytes={settings.payloadMaxBytes}
            activeStore={resolved.store.name}
            ttlSeconds={LOG_SETTINGS_TTL_MS / 1000}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

Add `import { GovernanceForm } from './governance-form'` at the top. Task 15
adds the last-prune line to this page; it is deliberately absent here so this
task ships no unused code.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

Manual check: `pnpm dev`, open `/settings`. Switch the store to `stdout`, save, then open `/logs` and confirm the unreadable-store empty state appears. Switch back to `postgres` and confirm the rows return — proving the "switching does not delete history" claim the form makes.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/settings" src/components/ui/tabs.tsx
git commit -m "feat: add a Settings page with a Governance tab"
```

---

### Task 15: Retention

**Files:**
- Create: `src/instrumentation.ts`, `src/lib/logs/retention.ts`
- Modify: `src/app/(admin)/settings/page.tsx`
- Test: `tests/lib/logs/retention.test.ts`

**Interfaces:**
- Consumes: `resolveRequestLogStore` (Task 7), `postgresStore.prune` (Task 6).
- Produces: `pruneRequestLogs(now?: Date): Promise<number | null>` — the row count, or `null` when the run was skipped (retention disabled, or another instance holds the lock).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/logs/retention.test.ts
import { beforeEach, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { PRUNE_LOCK_KEY, pruneRequestLogs } from '@/lib/logs/retention'
import { setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../../helpers/db'

const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

async function writeOne(requestId: string) {
  await postgresStore.write({
    requestId, keyId: null, keyName: null, model: 'm',
    stream: false, status: 200, outcome: 'ok', latencyMs: 1, attempts: [],
  })
}

test('deletes rows older than the retention window', async () => {
  await writeOne('old')
  // Rows are pruned by their v7 id, so "now" moving forward is what makes the
  // existing row old.
  const later = new Date(Date.now() + 31 * DAY)

  expect(await pruneRequestLogs(later)).toBe(1)
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)
})

test('keeps rows inside the window', async () => {
  await writeOne('fresh')
  expect(await pruneRequestLogs(new Date())).toBe(0)
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
})

test('zero retention disables pruning entirely', async () => {
  await setLoggingSettings({ retentionDays: 0 })
  clearRequestLogStoreCache()
  await writeOne('kept')

  expect(await pruneRequestLogs(new Date(Date.now() + 400 * DAY))).toBeNull()
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
})

test('skips the run when another instance holds the lock', async () => {
  await writeOne('old')
  const holder = await db.$client.connect()
  await holder.query('SELECT pg_advisory_lock($1)', [PRUNE_LOCK_KEY.toString()])

  try {
    expect(await pruneRequestLogs(new Date(Date.now() + 31 * DAY))).toBeNull()
    expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [PRUNE_LOCK_KEY.toString()])
    holder.release()
  }
})

test('records when it last ran', async () => {
  await writeOne('old')
  await pruneRequestLogs(new Date(Date.now() + 31 * DAY))

  const rows = await db.execute(sql`SELECT value FROM settings WHERE key = 'logs.last_prune'`)
  expect(rows.rowCount).toBe(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/retention.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/retention`.

If `db.$client` is not a `pg.Pool` on this drizzle version, replace the lock-holder in the fourth test with a directly constructed `new Pool({ connectionString: process.env.DATABASE_URL })`, and end it in the `finally`.

- [ ] **Step 3: Implement**

```ts
// src/lib/logs/retention.ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { resolveRequestLogStore } from './registry'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from the
 * migration runner's key in scripts/migrate.mjs. */
export const PRUNE_LOCK_KEY = 5_512_998_004_117_336n

const HOUR_MS = 60 * 60 * 1000

/**
 * Deletes expired request logs.
 *
 * Returns the number of rows removed, or null when the run was skipped —
 * retention is disabled, or another instance is already pruning.
 */
export async function pruneRequestLogs(now: Date = new Date()): Promise<number | null> {
  const { store, settings: config } = await resolveRequestLogStore()
  if (config.retentionDays <= 0) return null

  // A session advisory lock, taken with try_ so a second instance skips
  // instead of queueing behind a prune it would only repeat.
  const acquired = await db.execute(
    sql`SELECT pg_try_advisory_lock(${PRUNE_LOCK_KEY.toString()}::bigint) AS locked`,
  )
  if (!acquired.rows[0]?.locked) return null

  try {
    const cutoff = new Date(now.getTime() - config.retentionDays * 24 * HOUR_MS)
    const deleted = await store.prune(cutoff)

    await db
      .insert(settings)
      .values({
        key: 'logs.last_prune',
        value: { at: new Date().toISOString(), deleted },
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { at: new Date().toISOString(), deleted }, updatedAt: new Date() },
      })

    return deleted
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${PRUNE_LOCK_KEY.toString()}::bigint)`)
  }
}

let timer: NodeJS.Timeout | null = null

/** Starts the hourly prune. Idempotent, because Next may evaluate a module
 * more than once in development. */
export function startRetentionTimer(): void {
  if (timer) return
  timer = setInterval(() => {
    void pruneRequestLogs().catch((err) =>
      console.error('[gateway] request log pruning failed', err),
    )
  }, HOUR_MS)
  // Never hold the process open for a log-cleanup timer.
  timer.unref()
}
```

- [ ] **Step 4: Add the boot hook**

```ts
// src/instrumentation.ts

/**
 * Runs once per server instance, before it serves anything.
 *
 * The nodejs guard matters: this file is also evaluated for the edge runtime,
 * where setInterval and a database connection are both wrong.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startRetentionTimer } = await import('@/lib/logs/retention')
  startRetentionTimer()
}
```

- [ ] **Step 5: Show the last prune on the Settings page**

In `src/app/(admin)/settings/page.tsx`, add the `prune` helper described in Task 14, read the row, and render it under the form inside the Governance tab:

```tsx
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings as settingsTable } from '@/lib/db/schema'

// ...inside the component, alongside the existing reads:
  const [lastPrune] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, 'logs.last_prune'))
    .limit(1)

// ...inside TabsContent, after <GovernanceForm />:
        <p className="pt-6 text-xs text-muted-foreground">
          Retention last ran: {prune(lastPrune?.value as { at: string; deleted: number } | undefined ?? null)}
        </p>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/retention.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
git add src/instrumentation.ts src/lib/logs/retention.ts "src/app/(admin)/settings/page.tsx" tests/lib/logs/retention.test.ts
git commit -m "feat: prune expired request logs hourly behind an advisory lock"
```

---

### Task 16: Documentation and final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Document the feature in `README.md`**

Add a `## Governance` section after the existing admin-UI material, covering:

- **Request logs.** Every request is recorded: the caller's key name, the model asked for, status and outcome, latency and time-to-first-token, the full attempt chain with each target's failure reason, token counts, and cost. Reachable at `/logs`, with a detail page per request id.
- **Choosing a store.** Settings › Governance. `postgres` (default, readable) and `stdout` (write-only, one JSON line per request). A change takes effect on the instance that made it immediately, and on every other instance within 15 seconds. Switching does not migrate existing logs.
- **The Postgres warning.** Verbatim in prose: the default store writes to the gateway's own database, which is right for development and low traffic; at high request rates the table and its three indexes compete with the queries that serve requests.
- **Upgrade note.** `postgres` is the default, so a gateway upgraded from an earlier version starts writing logs to its database. Selecting `stdout` restores exactly the previous behavior. The stdout line itself gained token and cost keys — additive, so existing parsers keep working.
- **Payload capture.** Off by default, enabled per API key on the API keys page, bounded by the payload cap in Settings › Governance.
- **Retention.** Hourly, driven by the retention-days setting; `0` disables it. Exactly one instance prunes at a time.
- Update the existing line near `README.md:357` that says debugging a request means searching container logs by `x-request-id`: that is now the fallback when the store is `stdout`, and the request-id lookup on `/logs` is the primary path.

- [ ] **Step 2: Full verification**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all four clean. Record the test count — it should be 536 plus roughly 60 new tests.

- [ ] **Step 3: Manual end-to-end check**

With `pnpm dev` and a provider configured:

1. Send a non-streaming request. Confirm one row on `/logs` with latency and status.
2. Send a streaming request. Confirm `stream: true`, a TTFT, and token counts.
3. Enable payload logging on the key, repeat both, confirm the payloads render on the detail page.
4. Price the model in the catalog, send another request, confirm a cost appears and an older unpriced row still says "unpriced".
5. Switch the store to `stdout` in Settings, confirm `/logs` shows the empty state and `pnpm dev`'s console shows the JSON line.
6. Switch back to `postgres`, confirm the earlier rows are still there.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document Governance request logs and store selection"
```

---

## Self-Review Notes

Spec coverage was checked section by section against the tasks:

| Spec section | Task |
|---|---|
| §3 store contract, module layout | 4, 6, 7 |
| §4 uuid v7, both tables, indexes, envelope | 1, 2, 5 |
| §5 settings keys, resolution, 15s cache, switching | 3, 7, 14 |
| §6 write path, usage, cost, payloads | 8, 9, 10 |
| §7 nav, routes, filters, banners, detail, settings page | 11, 12, 13, 14 |
| §8 retention | 15 |
| §9 error handling | 7 (fallbacks), 9 (write failure), 12 (unreadable store) |
| §10 testing | every task |
| §11 consequences to document | 16 |

Two spec items are deliberately *not* built, and both are stated in the spec as
forward-looking rather than in scope: encrypted `logs.store_config` for driver
credentials (no shipped driver has credentials) and the `flush()` call on
shutdown (neither shipped driver buffers, so there is nothing to drain —
`flush?` stays optional on the interface for the driver that needs it).

