# Routing Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `virtual_models.policy`, `route_targets.weight` and `virtual_models.max_attempts` actually route, by ordering every eligible target into an attempt chain and walking it until one succeeds.

**Architecture:** A pure `selectOrder()` turns the eligible candidate list into a policy-ordered chain; a generic `execute()` walks that chain calling a caller-supplied `run`, so streaming and non-streaming share one loop and one failover boundary. Provider errors are normalised into a `ProviderError` inside the adapter before they escape, so the loop's retryable/fatal decision no longer depends on the gateway recognising each SDK's error classes. Each settled request emits one JSON line on stdout carrying the whole attempt chain.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, drizzle-orm 0.45 on node-postgres, `openai` 7.4 SDK, Vitest 4 against a real Postgres.

**Spec:** `docs/superpowers/specs/2026-08-12-routing-engine-design.md`

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing App Router or server-action code. Do not assume APIs from memory. (This plan touches no App Router code, so it should not come up.)
- **No migration.** Phase 2 adds no table and no column. Do **not** run `drizzle-kit generate` or edit `src/lib/db/schema.ts`.
- **No new dependencies.** Nothing may be added to `package.json`.
- **No circuit breaker.** `target_health`, breaker state, cooldowns and probe scheduling are explicitly out of scope and deferred to a later phase. Do not add them "while you're in there".
- **No `request_logs` table, no `/logs` page, no admin UI at all.** Phase 2 is backend-only. Observability is stdout.
- **No `rr_cursors` table.** The round-robin cursor is process memory, by decision.
- **Tests run against a real database.** `pnpm test` needs Postgres up (`docker compose up -d`). Test files run serially by design (`vitest.config.ts`).
- **Run tests with the file path**, e.g. `pnpm test tests/lib/gateway/select.test.ts`. `pnpm test` alone runs everything.
- **Commit after every task.** Each task ends with a working tree that passes `pnpm test` and `pnpm lint`.
- **`AGENTS.md` churn:** `next dev` rewrites a block in `AGENTS.md`. If it shows up dirty, commit it with your work rather than reverting it.
- **Comment style:** this codebase writes comments that explain *why*, in full sentences, above the code they describe. Match it. Do not add narrating comments that restate the line below them.
- **Existing tests must stay green.** In particular `tests/gateway/chat.test.ts`, `tests/gateway/chat-stream.test.ts` and `tests/contract/openai-client.test.ts` all exercise single-target models and must not need editing except where a task says so explicitly.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/gateway/errors.ts` | Add `ProviderError` (the normalised shape adapters throw) and `RoutedError` (a `GatewayError` carrying the attempt chain). `classifyProviderError` gains a `ProviderError` branch ahead of everything else. |
| `src/lib/adapters/openai/errors.ts` (new) | `toProviderError()` — the OpenAI SDK's error shapes to `ProviderError`. The file each future adapter copies. |
| `src/lib/adapters/openai/index.ts` | Wrap `chat` and `chatStream` call sites in `toProviderError`. |
| `src/lib/gateway/rr-cursor.ts` (new) | The in-memory round-robin cursor. One `Map`, two functions. |
| `src/lib/gateway/select.ts` (new) | `selectOrder()` — policy to ordered, truncated attempt chain. Pure. |
| `src/lib/gateway/execute.ts` (new) | `execute()` — the attempt loop, plus `attemptContext()` moved here from the handler. |
| `src/lib/gateway/request-log.ts` (new) | `buildRequestLog()` / `emitRequestLog()`. The only place a log line is formatted. |
| `src/lib/gateway/sse.ts` | `sseResponse` gains an `onSettle` callback that fires exactly once. |
| `src/lib/gateway/chat-handler.ts` | Shrinks to orchestration: auth → parse → resolve → select → execute → respond → log. |

Tests mirror the source tree: `tests/lib/gateway/{select,execute,request-log,errors}.test.ts`, `tests/lib/adapters/openai/errors.test.ts`, and additions to `tests/gateway/{chat,chat-stream}.test.ts`.

---

### Task 1: `ProviderError` and adapter-owned classification

Both handoff documents flag this as the thing to decide before Phase 2 code. Today `classifyProviderError` only recognises `OpenAI.APIError`, so any other SDK's error would fall through to `retryable: true, 502` — which, once Task 5 adds a failover loop, means a fatal Gemini 400 would burn every remaining attempt and reach the client as a 502.

The fix moves classification behind the adapter boundary. The logic itself is unchanged — it is lifted out of `classifyProviderError` into the OpenAI adapter, and `classifyProviderError` keeps its old branches as a fallback for anything unwrapped.

**Files:**
- Modify: `src/lib/gateway/errors.ts`
- Create: `src/lib/adapters/openai/errors.ts`
- Modify: `src/lib/adapters/openai/index.ts`
- Test: `tests/lib/gateway/errors.test.ts` (append)
- Test: `tests/lib/adapters/openai/errors.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class ProviderError extends Error` from `@/lib/gateway/errors`, with readonly `status: number`, `code: string | null`, `type: string`, `retryable: boolean`.
  - `interface ProviderErrorInit { status: number; message: string; code?: string | null; type?: string; retryable: boolean }` from `@/lib/gateway/errors`.
  - `toProviderError(err: unknown): ProviderError` from `@/lib/adapters/openai/errors`.

- [ ] **Step 1: Write the failing tests for `ProviderError` classification**

Append to `tests/lib/gateway/errors.test.ts`, and add `ProviderError` to the existing import from `@/lib/gateway/errors` on lines 3-8:

```ts
test('a ProviderError classifies as itself, without re-deriving anything', () => {
  const classified = classifyProviderError(
    new ProviderError({
      status: 400,
      code: 'invalid_argument',
      type: 'invalid_request_error',
      message: 'tools[0].parameters is not valid',
      retryable: false,
    }),
  )

  expect(classified).toEqual({
    retryable: false,
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_argument',
    message: 'tools[0].parameters is not valid',
  })
})

test('a retryable ProviderError stays retryable even at a 4xx status', () => {
  // The whole point of moving classification into the adapter: only the
  // adapter knows that this provider's 400 means "overloaded, try again".
  const classified = classifyProviderError(
    new ProviderError({ status: 400, message: 'overloaded', retryable: true }),
  )

  expect(classified.retryable).toBe(true)
  expect(classified.status).toBe(400)
})

test('a ProviderError defaults its type from retryability', () => {
  expect(new ProviderError({ status: 503, message: 'x', retryable: true }).type)
    .toBe('api_error')
  expect(new ProviderError({ status: 400, message: 'x', retryable: false }).type)
    .toBe('invalid_request_error')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/errors.test.ts`
Expected: FAIL — `ProviderError` is not exported (an import or TypeScript error naming it).

- [ ] **Step 3: Add `ProviderError` to `errors.ts`**

Insert into `src/lib/gateway/errors.ts`, directly after the `UnsupportedOperationError` class (after line 32):

```ts
export interface ProviderErrorInit {
  status: number
  message: string
  code?: string | null
  type?: string
  retryable: boolean
}

/**
 * A provider failure that has already been interpreted by the adapter that
 * produced it. Adapters throw this instead of their SDK's own error class,
 * because only the adapter knows which of its provider's statuses are worth
 * retrying — a fact the failover loop cannot rederive from an HTTP status.
 */
export class ProviderError extends Error {
  readonly status: number
  readonly code: string | null
  readonly type: string
  readonly retryable: boolean

  constructor(init: ProviderErrorInit) {
    super(init.message)
    this.name = 'ProviderError'
    this.status = init.status
    this.code = init.code ?? null
    this.type = init.type ?? (init.retryable ? 'api_error' : 'invalid_request_error')
    this.retryable = init.retryable
  }
}
```

- [ ] **Step 4: Classify `ProviderError` first**

In `src/lib/gateway/errors.ts`, insert this as the first branch of `classifyProviderError`, above the `UnsupportedOperationError` check:

```ts
  // Already interpreted by its adapter. Everything below this line is the
  // fallback for errors that escaped an adapter unwrapped.
  if (err instanceof ProviderError) {
    return {
      retryable: err.retryable,
      status: err.status,
      type: err.type,
      code: err.code,
      message: err.message,
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/errors.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Write the failing tests for the OpenAI mapping**

Create `tests/lib/adapters/openai/errors.test.ts`:

```ts
import { expect, test } from 'vitest'
import OpenAI from 'openai'
import { toProviderError } from '@/lib/adapters/openai/errors'
import { ProviderError } from '@/lib/gateway/errors'

// `OpenAI.APIError`'s constructor is `(status, error, message, headers)` where
// `error` is the already-unwrapped error body — see `APIError.generate()` in
// openai/src/core/error.ts, which does `errorResponse?.['error']` first.
function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

test.each([408, 409, 429, 500, 502, 503, 504])('status %s maps to retryable', (status) => {
  expect(toProviderError(apiError(status)).retryable).toBe(true)
})

test.each([400, 401, 403, 404, 413, 422, 499])('status %s maps to fatal', (status) => {
  expect(toProviderError(apiError(status)).retryable).toBe(false)
})

test('a connection error with no status is retryable as a 502', () => {
  const mapped = toProviderError(new OpenAI.APIConnectionError({}))
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(502)
})

test('an abort maps to a retryable 504 upstream_timeout', () => {
  const mapped = toProviderError(new DOMException('aborted', 'AbortError'))
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(504)
  expect(mapped.code).toBe('upstream_timeout')
})

test('the upstream status, code and message survive the mapping', () => {
  const mapped = toProviderError(apiError(400, 'context_length_exceeded'))
  expect(mapped).toBeInstanceOf(ProviderError)
  expect(mapped.status).toBe(400)
  expect(mapped.code).toBe('x')
  expect(mapped.message).toContain('context_length_exceeded')
})

test('an unknown throwable becomes a retryable 502 rather than being swallowed', () => {
  const mapped = toProviderError('a string, somehow')
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(502)
  expect(mapped.code).toBe('upstream_error')
})

test('an already-mapped ProviderError passes through untouched', () => {
  const original = new ProviderError({ status: 429, message: 'slow down', retryable: true })
  expect(toProviderError(original)).toBe(original)
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm test tests/lib/adapters/openai/errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/openai/errors`.

- [ ] **Step 8: Implement the mapping**

Create `src/lib/adapters/openai/errors.ts`:

```ts
import OpenAI from 'openai'
import { ProviderError } from '@/lib/gateway/errors'

// 408 and 409 are transport-ish rather than a rejection of the request, and
// 429 is the one status where retrying against a *different* provider is
// exactly the right move. Everything else below 500 is the provider telling
// us the request itself is wrong, which another provider would only reject
// differently.
const RETRYABLE_STATUSES = new Set([408, 409, 429])

/**
 * Interprets an OpenAI SDK failure so the routing loop does not have to.
 * This is the file every future adapter writes its own version of; the
 * gateway's own classifier is only a fallback for errors that escape one.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status ?? 502,
      code: err.code ?? null,
      ...(err.type ? { type: err.type } : {}),
      message: err.message,
      retryable,
    })
  }

  // DOMException does not extend Error on every runtime this may run on, so
  // both checks are needed to catch an abort.
  const isAbort =
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')

  return new ProviderError({
    status: isAbort ? 504 : 502,
    code: isAbort ? 'upstream_timeout' : 'upstream_error',
    message: err instanceof Error ? err.message : 'Upstream request failed',
    retryable: true,
  })
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test tests/lib/adapters/openai/errors.test.ts`
Expected: PASS.

- [ ] **Step 10: Wrap the adapter's call sites**

In `src/lib/adapters/openai/index.ts`, add to the imports at the top of the file:

```ts
import { toProviderError } from './errors'
```

Replace the `chat` method (currently lines 45-52) with:

```ts
    async chat(req, ctx): Promise<ChatCompletion> {
      const params = {
        ...upstreamParams(req, ctx),
        stream: false as const,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

      try {
        return await client.chat.completions.create(params, { signal: ctx.signal })
      } catch (err) {
        throw toProviderError(err)
      }
    },
```

Replace the `chatStream` method (currently lines 54-69) with:

```ts
    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      const base = upstreamParams(req, ctx)
      const streamOptions = runtime.config.disableStreamUsage
        ? {}
        : { stream_options: { include_usage: true, ...(base.stream_options ?? {}) } }

      const params = {
        ...base,
        ...streamOptions,
        stream: true as const,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway
      // has committed a response, the second after. Both must arrive at the
      // routing loop already interpreted.
      let stream
      try {
        stream = await client.chat.completions.create(params, { signal: ctx.signal })
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        for await (const chunk of stream) yield chunk
      } catch (err) {
        throw toProviderError(err)
      }
    },
```

Leave `listModels` alone — `src/lib/catalog/sync.ts` classifies discovery failures itself with `describeDiscoveryError`, and deliberately does not go through the request path's classifier.

- [ ] **Step 11: Run the whole suite**

Run: `pnpm test`
Expected: PASS. `tests/lib/adapters/openai/stream.test.ts` asserts on error *messages* (`'upstream down'`, `'connection reset'`), which `toProviderError` preserves.

- [ ] **Step 12: Typecheck, lint and commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): normalise provider errors inside the adapter

classifyProviderError only understood OpenAI.APIError, so any other SDK's
error fell through to retryable/502. Once failover exists that would burn
every attempt on a request that can never succeed. Adapters now throw a
ProviderError they have already interpreted; the gateway's classifier
keeps its old branches as a fallback for anything unwrapped."
```

---

### Task 2: `selectOrder` with the failover policy and attempt cap

The pure core of routing. `resolveVirtualModel` already returns eligible candidates in `(priority, createdAt, id)` order, which *is* the failover chain — so this task is mostly about establishing the signature and the `max_attempts` truncation that the other two policies will slot into.

`selectOrder` takes a structural subset of `VirtualModelRow` rather than the row itself, so its tests do not need to build a database row.

**Files:**
- Create: `src/lib/gateway/select.ts`
- Test: `tests/lib/gateway/select.test.ts` (new)

**Interfaces:**
- Consumes: `Candidate` from `@/lib/gateway/resolve` (`{ targetId, provider, upstreamModel, priority, weight }`).
- Produces:
  - `interface SelectDeps { random: () => number; nextCursor: (virtualModelId: string) => number }` from `@/lib/gateway/select`.
  - `interface SelectableModel { id: string; policy: 'failover' | 'weighted' | 'round_robin'; maxAttempts: number }` from `@/lib/gateway/select`.
  - `selectOrder(candidates: Candidate[], model: SelectableModel, deps?: Partial<SelectDeps>): Candidate[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/gateway/select.test.ts`:

```ts
import { expect, test } from 'vitest'
import { selectOrder, type SelectableModel } from '@/lib/gateway/select'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ProviderRow } from '@/lib/db/schema'

/**
 * selectOrder only ever reads `name` off the provider, so the rest of the row
 * is stubbed rather than built — these tests deliberately touch no database.
 */
function candidate(name: string, weight = 100, priority = 0): Candidate {
  return {
    targetId: `target-${name}`,
    provider: { name } as ProviderRow,
    upstreamModel: `${name}-model`,
    priority,
    weight,
  }
}

function model(patch: Partial<SelectableModel> = {}): SelectableModel {
  return { id: 'vm-1', policy: 'failover', maxAttempts: 3, ...patch }
}

const names = (chain: Candidate[]) => chain.map((c) => c.provider.name)

test('failover keeps the order it was given', () => {
  const chain = selectOrder([candidate('a'), candidate('b'), candidate('c')], model())
  expect(names(chain)).toEqual(['a', 'b', 'c'])
})

test('the chain is capped at max_attempts', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
    model({ maxAttempts: 2 }),
  )
  expect(names(chain)).toEqual(['a', 'b'])
})

test('a chain shorter than max_attempts is not padded', () => {
  const chain = selectOrder([candidate('a')], model({ maxAttempts: 5 }))
  expect(names(chain)).toEqual(['a'])
})

test('a nonsensical max_attempts still yields one attempt rather than none', () => {
  // The column is a plain integer with no check constraint, so 0 is storable.
  // Returning an empty chain would turn a misconfiguration into a request
  // that fails without ever contacting a provider.
  expect(selectOrder([candidate('a'), candidate('b')], model({ maxAttempts: 0 })))
    .toHaveLength(1)
})

test('the input array is never mutated', () => {
  const input = [candidate('a'), candidate('b')]
  const copy = [...input]
  selectOrder(input, model({ policy: 'weighted' }), { random: () => 0.5 })
  expect(input).toEqual(copy)
})

test('an empty candidate list yields an empty chain rather than throwing', () => {
  expect(selectOrder([], model())).toEqual([])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/select.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/select`.

- [ ] **Step 3: Implement `select.ts` with failover only**

Create `src/lib/gateway/select.ts`:

```ts
import type { Candidate } from './resolve'

export interface SelectDeps {
  random: () => number
  nextCursor: (virtualModelId: string) => number
}

/**
 * The structural subset of a virtual model that selection needs. Taking this
 * rather than the row means these functions can be tested without a database.
 */
export interface SelectableModel {
  id: string
  policy: 'failover' | 'weighted' | 'round_robin'
  maxAttempts: number
}

/**
 * Orders every eligible target into the chain the attempt loop will walk.
 * Pure: the caller injects randomness and the round-robin cursor, which is
 * what makes weighted and round-robin selection testable at all.
 *
 * `candidates` arrives already filtered to enabled targets on enabled
 * providers and already sorted by (priority, createdAt, id) — see
 * resolveVirtualModel. That tie-break is load-bearing for round robin.
 */
export function selectOrder(
  candidates: Candidate[],
  model: SelectableModel,
  _deps: Partial<SelectDeps> = {},
): Candidate[] {
  if (candidates.length === 0) return []

  const ordered = candidates

  // max_attempts is a bare integer column, so a 0 or a negative is storable.
  // One attempt is the smallest number that still asks a provider anything.
  return ordered.slice(0, Math.max(1, model.maxAttempts))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/select.test.ts`
Expected: PASS. The "never mutated" test passes trivially at this point; Task 3 is what puts it under real pressure.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): add selectOrder with the failover policy

The pure core of routing: eligible candidates in, the attempt chain the
loop will walk out. Failover is the order resolveVirtualModel already
produces, so this task is really about the signature and the
max_attempts cap that weighted and round robin slot into."
```

---

### Task 3: Weighted selection

The whole chain is weighted, not just its head. Weighting only the first pick would mean traffic distribution silently collapses onto whichever target sorts first the moment anything starts failing — which is the case the weights are least able to be checked in and most needed.

**Files:**
- Modify: `src/lib/gateway/select.ts`
- Test: `tests/lib/gateway/select.test.ts` (append)

**Interfaces:**
- Consumes: `selectOrder`, `SelectableModel`, `candidate()` and `model()` helpers from Task 2.
- Produces: no new exports. `selectOrder` honours `policy: 'weighted'` and the injected `deps.random`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/gateway/select.test.ts`:

```ts
// Weighted selection draws without replacement, so each pick consumes one
// `random()` value against the *remaining* pool's total. A queue of rolls
// makes each draw's bucket explicit rather than depending on Math.random.
function rolls(...values: number[]) {
  const queue = [...values]
  return () => queue.shift() ?? 0
}

test('weighted picks the bucket the roll lands in', () => {
  // Weights 10/20/70 over a total of 100 give buckets a=[0,10), b=[10,30),
  // c=[30,100). A roll of 0.5 lands at 50, inside c.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['c'])
})

test('a roll at the very start of the range picks the first target', () => {
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0) },
  )
  expect(names(chain)).toEqual(['a'])
})

test('a roll at the top of the range picks the last target rather than falling off', () => {
  // Floating-point accumulation can leave the running total a hair short of
  // the roll, so the last bucket must be the fallback rather than undefined.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0.999999999) },
  )
  expect(names(chain)).toEqual(['c'])
})

test('the whole chain is weighted, not just its head', () => {
  // First draw: total 100, roll 0.05 -> 5 -> a. Remaining pool b(20) c(70),
  // total 90, roll 0.5 -> 45 -> lands past b's [0,20) into c.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.05, 0.5) },
  )
  expect(names(chain)).toEqual(['a', 'c', 'b'])
})

test('every target appears exactly once — draws are without replacement', () => {
  const chain = selectOrder(
    [candidate('a', 1), candidate('b', 1), candidate('c', 1), candidate('d', 1)],
    model({ policy: 'weighted', maxAttempts: 10 }),
    { random: rolls(0.9, 0.9, 0.9, 0.9) },
  )
  expect([...names(chain)].sort()).toEqual(['a', 'b', 'c', 'd'])
})

test('a zero-weight target sorts last instead of being dropped', () => {
  // Weight 0 most plausibly means "prefer never", not "delete". Dropping it
  // would turn a weight edit into a silent capacity cut, and a model whose
  // targets are all zero would have no targets at all.
  const chain = selectOrder(
    [candidate('cheap', 0), candidate('a', 50), candidate('b', 50)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.9, 0.9) },
  )
  expect(names(chain).at(-1)).toBe('cheap')
  expect(names(chain)).toHaveLength(3)
})

test('a negative weight is treated as zero, not as a negative probability', () => {
  const chain = selectOrder(
    [candidate('bad', -5), candidate('a', 100)],
    model({ policy: 'weighted', maxAttempts: 2 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['a', 'bad'])
})

test('all-zero weights still produce a usable chain in input order', () => {
  const chain = selectOrder(
    [candidate('a', 0), candidate('b', 0)],
    model({ policy: 'weighted', maxAttempts: 2 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['a', 'b'])
})

test('a single weighted candidate needs no roll at all', () => {
  const chain = selectOrder(
    [candidate('only', 100)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: () => { throw new Error('random() should not be needed') } },
  )
  expect(names(chain)).toEqual(['only'])
})
```

Note on that last test: with one positive-weight candidate the loop still runs once and *will* call `random()`. Write the implementation so it short-circuits a single-element pool — that is what this test pins.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/select.test.ts`
Expected: FAIL — the weighted tests get failover's input order back (e.g. `['a','b','c']` where `['c']` was expected).

- [ ] **Step 3: Implement weighted selection**

In `src/lib/gateway/select.ts`, add above `selectOrder`:

```ts
/**
 * Draws the whole chain by repeated cumulative-weight pick without
 * replacement, so failover order is weighted too. Weighting only the first
 * pick would collapse the distribution onto whichever target sorts first
 * exactly when something is failing.
 *
 * Non-positive weights are appended in input order rather than dropped: a
 * weight of 0 reads as "prefer never", and dropping it would leave a model
 * whose targets are all zero with nothing to try.
 */
function weightedOrder(candidates: Candidate[], random: () => number): Candidate[] {
  const pool = candidates.filter((c) => c.weight > 0)
  const rest = candidates.filter((c) => c.weight <= 0)
  const order: Candidate[] = []

  while (pool.length > 0) {
    if (pool.length === 1) {
      order.push(pool.pop()!)
      break
    }

    const total = pool.reduce((sum, c) => sum + c.weight, 0)
    let roll = random() * total
    // Defaulting to the last index rather than -1 means a roll that floating
    // point leaves fractionally above the running total picks the final
    // bucket instead of nothing.
    let index = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      roll -= pool[i].weight
      if (roll < 0) {
        index = i
        break
      }
    }
    order.push(pool.splice(index, 1)[0])
  }

  return [...order, ...rest]
}
```

Then change `selectOrder`'s body — replace `const ordered = candidates` with:

```ts
  const { random = Math.random } = _deps
  const ordered =
    model.policy === 'weighted' ? weightedOrder(candidates, random) : candidates
```

and rename the parameter `_deps` to `deps` in the signature.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/select.test.ts`
Expected: PASS, including Task 2's "the input array is never mutated" test — `filter` and `splice` operate on copies, never on the caller's array.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): weighted target selection

Repeated cumulative-weight pick without replacement, so the failover
chain is weighted too rather than collapsing onto whichever target
sorts first the moment anything fails. Zero and negative weights sort
last instead of being dropped."
```

---

### Task 4: Round-robin selection

The cursor lives in process memory by decision — correct for the single-instance deployment this runs as, and wrong across several. It gets its own module so the whole of that decision is five lines to replace if it ever needs Postgres.

The policy rotates the eligible list rather than only picking its head, so the failover chain after the first target stays deterministic.

**Files:**
- Create: `src/lib/gateway/rr-cursor.ts`
- Modify: `src/lib/gateway/select.ts`
- Test: `tests/lib/gateway/rr-cursor.test.ts` (new)
- Test: `tests/lib/gateway/select.test.ts` (append)

**Interfaces:**
- Consumes: `selectOrder`, `SelectableModel`, and the `candidate()` / `model()` / `names()` helpers from Task 2.
- Produces:
  - `nextCursor(virtualModelId: string): number` from `@/lib/gateway/rr-cursor` — returns the current value then advances.
  - `resetCursors(): void` from `@/lib/gateway/rr-cursor` — test-only reset.
  - `selectOrder` honours `policy: 'round_robin'` and the injected `deps.nextCursor`.

- [ ] **Step 1: Write the failing tests for the cursor**

Create `tests/lib/gateway/rr-cursor.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { nextCursor, resetCursors } from '@/lib/gateway/rr-cursor'

beforeEach(() => {
  resetCursors()
})

test('the first call for a model returns zero', () => {
  expect(nextCursor('vm-1')).toBe(0)
})

test('successive calls advance', () => {
  expect([nextCursor('vm-1'), nextCursor('vm-1'), nextCursor('vm-1')]).toEqual([0, 1, 2])
})

test('each virtual model keeps its own cursor', () => {
  nextCursor('vm-1')
  nextCursor('vm-1')
  expect(nextCursor('vm-2')).toBe(0)
  expect(nextCursor('vm-1')).toBe(2)
})

test('the cursor wraps rather than growing without bound', () => {
  // A long-lived process would otherwise walk a counter toward
  // MAX_SAFE_INTEGER, where increments stop being exact.
  for (let i = 0; i < 3; i += 1) nextCursor('vm-wrap')
  expect(nextCursor('vm-wrap')).toBeLessThan(0x7fffffff)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/rr-cursor.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/rr-cursor`.

- [ ] **Step 3: Implement the cursor**

Create `src/lib/gateway/rr-cursor.ts`:

```ts
/**
 * Round-robin cursors, one per virtual model, held in process memory.
 *
 * This is deliberately not the `rr_cursors` table the gateway spec describes.
 * In-memory is correct for a single instance and skews across several — two
 * processes keep independent counters, both start at zero, and both favour
 * the same target. That trade was made knowingly; this module exists so that
 * reversing it means replacing one file rather than untangling selection.
 *
 * State also resets on restart, which round robin tolerates: the guarantee is
 * "spread requests across targets", not "resume where the last process left".
 */
const cursors = new Map<string, number>()

// Kept well inside the exact-integer range so a long-lived process never
// reaches the point where += 1 stops changing the value.
const WRAP = 0x7fffffff

/** Returns the current cursor for a model, then advances it. */
export function nextCursor(virtualModelId: string): number {
  const current = cursors.get(virtualModelId) ?? 0
  cursors.set(virtualModelId, (current + 1) % WRAP)
  return current
}

/** Test-only. Nothing in the request path should ever clear cursors. */
export function resetCursors(): void {
  cursors.clear()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/rr-cursor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the policy**

Append to `tests/lib/gateway/select.test.ts`:

```ts
function cursorOf(value: number) {
  return () => value
}

test('round robin rotates the eligible list by the cursor', () => {
  const targets = [candidate('a'), candidate('b'), candidate('c')]
  const rr = model({ policy: 'round_robin', maxAttempts: 3 })

  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(0) })))
    .toEqual(['a', 'b', 'c'])
  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(1) })))
    .toEqual(['b', 'c', 'a'])
  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(2) })))
    .toEqual(['c', 'a', 'b'])
})

test('a cursor past the end of the list wraps', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'round_robin', maxAttempts: 3 }),
    { nextCursor: cursorOf(7) },
  )
  expect(names(chain)).toEqual(['b', 'c', 'a'])
})

test('round robin is asked for the cursor of the model being routed', () => {
  const seen: string[] = []
  selectOrder(
    [candidate('a'), candidate('b')],
    model({ id: 'vm-42', policy: 'round_robin' }),
    { nextCursor: (id) => { seen.push(id); return 0 } },
  )
  expect(seen).toEqual(['vm-42'])
})

test('round robin still respects max_attempts after rotating', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'round_robin', maxAttempts: 2 }),
    { nextCursor: cursorOf(1) },
  )
  expect(names(chain)).toEqual(['b', 'c'])
})

test('failover and weighted never touch the cursor', () => {
  const nextCursor = () => { throw new Error('cursor should not be consulted') }

  expect(() => selectOrder([candidate('a')], model(), { nextCursor })).not.toThrow()
  expect(() =>
    selectOrder([candidate('a', 1), candidate('b', 1)], model({ policy: 'weighted' }), {
      nextCursor,
      random: () => 0.5,
    }),
  ).not.toThrow()
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/select.test.ts`
Expected: FAIL — the rotation tests get the unrotated input order back.

- [ ] **Step 7: Implement rotation**

In `src/lib/gateway/select.ts`, add the import at the top:

```ts
import { nextCursor as defaultNextCursor } from './rr-cursor'
```

Add above `selectOrder`:

```ts
/**
 * Rotating, rather than only moving one target to the head, keeps the rest of
 * the failover chain in the tie-break order every instance shares — so a
 * request that has to fail over still walks a predictable sequence.
 */
function rotate(candidates: Candidate[], cursor: number): Candidate[] {
  const offset = ((cursor % candidates.length) + candidates.length) % candidates.length
  return [...candidates.slice(offset), ...candidates.slice(0, offset)]
}
```

Replace `selectOrder`'s ordering expression with:

```ts
  const { random = Math.random, nextCursor = defaultNextCursor } = deps
  const ordered =
    model.policy === 'weighted' ? weightedOrder(candidates, random)
    : model.policy === 'round_robin' ? rotate(candidates, nextCursor(model.id))
    : candidates
```

The `candidates.length === 0` guard at the top of `selectOrder` is what keeps `rotate`'s modulo away from a division by zero.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/select.test.ts tests/lib/gateway/rr-cursor.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): round-robin target selection

Rotates the eligible list by a per-model cursor, so the whole failover
chain stays deterministic rather than only its head. The cursor lives in
process memory by decision, isolated in its own module so swapping it
for the rr_cursors table later is a one-file change."
```

---

### Task 5: The attempt loop

`execute()` is generic over a `run` callback so streaming and non-streaming share one loop — which is what makes "failover applies to streams too, up to the first chunk" true by construction rather than by a second code path that has to be kept in step.

Three behaviours here are decisions, not mechanics, and each has a test:

- **A `createAdapter` failure advances to the next target** instead of aborting. `createAdapter` throws `UnsupportedOperationError` for `gemini` and `bedrock` — two of the four adapter types the provider form offers — so treating it as fatal would let one unimplemented target break every request to a model whose other targets are healthy.
- **An exhausted chain surfaces the *last* error**, so three rate-limited providers read as `429` rather than as a blanket `502`.
- **A client-initiated abort stops the loop**, rather than failing over onto a request nobody is waiting for.

**Files:**
- Create: `src/lib/gateway/execute.ts`
- Modify: `src/lib/gateway/errors.ts` (add `RoutedError`)
- Modify: `src/lib/gateway/chat-handler.ts` (remove `attemptContext`, which moves)
- Test: `tests/lib/gateway/execute.test.ts` (new)

**Interfaces:**
- Consumes: `Candidate` from `@/lib/gateway/resolve`; `classifyProviderError`, `GatewayError`, `ProviderError` from `@/lib/gateway/errors`; `AttemptContext`, `ProviderAdapter` from `@/lib/adapters/types`; the `candidate()` helper from Task 2's test file.
- Produces:
  - `interface AttemptRecord { n: number; targetId: string; provider: string; model: string; status: number; latencyMs: number; error?: string }` from `@/lib/gateway/execute`.
  - `interface ExecuteResult<T> { value: T; candidate: Candidate; attempts: AttemptRecord[] }` from `@/lib/gateway/execute`.
  - `interface ExecuteDeps { createAdapter: (provider: ProviderRow) => ProviderAdapter }` from `@/lib/gateway/execute`.
  - `execute<T>(chain, requestId, clientSignal, deps, run): Promise<ExecuteResult<T>>` from `@/lib/gateway/execute`.
  - `attemptContext(candidate: Candidate, requestId: string, clientSignal: AbortSignal): AttemptContext` from `@/lib/gateway/execute` (moved out of `chat-handler.ts`).
  - `class RoutedError extends GatewayError` from `@/lib/gateway/errors`, with readonly `attempts: AttemptSummary[]` and `lastProvider: string | null`. It reports the last provider by **name**, not as a `Candidate`: `Candidate` lives in `resolve.ts`, which imports `errors.ts`, so importing it back would be a cycle.
  - `interface AttemptSummary` from `@/lib/gateway/errors` — structurally identical to `AttemptRecord`, declared separately for the same reason.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/gateway/execute.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { execute } from '@/lib/gateway/execute'
import { ProviderError, RoutedError, UnsupportedOperationError } from '@/lib/gateway/errors'
import type { ProviderAdapter } from '@/lib/adapters/types'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ProviderRow } from '@/lib/db/schema'

function candidate(name: string): Candidate {
  return {
    targetId: `target-${name}`,
    provider: { id: `p-${name}`, name, config: '{}' } as ProviderRow,
    upstreamModel: `${name}-model`,
    priority: 0,
    weight: 100,
  }
}

/** Every provider gets the same stub adapter; `run` decides what happens. */
const stubAdapter = {} as ProviderAdapter
const deps = { createAdapter: () => stubAdapter }
const live = new AbortController().signal

test('the first target that succeeds ends the loop', async () => {
  const run = vi.fn().mockResolvedValue('body')
  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)

  expect(result.value).toBe('body')
  expect(result.candidate.provider.name).toBe('a')
  expect(run).toHaveBeenCalledTimes(1)
  expect(result.attempts).toHaveLength(1)
  expect(result.attempts[0]).toMatchObject({ n: 1, provider: 'a', status: 200 })
})

test('a retryable failure advances to the next target', async () => {
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 503, message: 'down', retryable: true }))
    .mockResolvedValueOnce('body')

  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)

  expect(result.candidate.provider.name).toBe('b')
  expect(result.attempts.map((a) => a.provider)).toEqual(['a', 'b'])
  expect(result.attempts[0]).toMatchObject({ n: 1, status: 503 })
  expect(result.attempts[0].error).toContain('down')
  expect(result.attempts[1]).toMatchObject({ n: 2, status: 200 })
  expect(result.attempts[1].error).toBeUndefined()
})

test('a fatal failure stops immediately without trying the rest', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 400, code: 'invalid_request', message: 'bad tools', retryable: false }),
  )

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  expect(run).toHaveBeenCalledTimes(1)
})

test('an exhausted chain surfaces the last error, not a generic 502', async () => {
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 500, message: 'boom', retryable: true }))
    .mockRejectedValueOnce(new ProviderError({ status: 429, code: 'rate_limit_exceeded', message: 'slow down', retryable: true }))

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
})

test('the thrown error carries every attempt made', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 500, message: 'boom', retryable: true }),
  )

  const err = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
    .catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RoutedError)
  expect((err as RoutedError).attempts.map((a) => a.provider)).toEqual(['a', 'b'])
  expect((err as RoutedError).lastProvider).toBe('b')
})

test('a chain of one is not retried', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 503, message: 'down', retryable: true }),
  )

  await expect(execute([candidate('a')], 'req_1', live, deps, run)).rejects.toThrow()
  expect(run).toHaveBeenCalledTimes(1)
})

test('a createAdapter failure skips that target instead of failing the request', async () => {
  // createAdapter throws UnsupportedOperationError for gemini and bedrock —
  // two of the four adapter types the provider form offers. Treating that as
  // fatal would let one unimplemented target break a model whose other
  // targets are perfectly healthy.
  const run = vi.fn().mockResolvedValue('body')
  const createAdapter = vi.fn()
    .mockImplementationOnce(() => { throw new UnsupportedOperationError('gemini is not available yet') })
    .mockImplementationOnce(() => stubAdapter)

  const result = await execute(
    [candidate('gem'), candidate('oai')], 'req_1', live, { createAdapter }, run,
  )

  expect(result.candidate.provider.name).toBe('oai')
  expect(result.attempts[0]).toMatchObject({ n: 1, provider: 'gem', status: 501 })
  expect(run).toHaveBeenCalledTimes(1)
})

test('a chain of only unconstructable targets surfaces the construction error', async () => {
  // The single-target gemini case, which tests/gateway/chat.test.ts pins as
  // a 501 rather than an opaque 500.
  const createAdapter = () => { throw new UnsupportedOperationError('gemini is not available yet') }

  await expect(
    execute([candidate('gem')], 'req_1', live, { createAdapter }, vi.fn()),
  ).rejects.toMatchObject({ status: 501, code: 'unsupported_operation' })
})

test('an UnsupportedOperationError from the call itself is fatal', async () => {
  // Unlike construction, this one describes the *operation* — another
  // provider would only fail differently.
  const run = vi.fn().mockRejectedValue(
    new UnsupportedOperationError('embeddings are not supported by this provider'),
  )

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 501 })
  expect(run).toHaveBeenCalledTimes(1)
})

test('a client disconnect stops the loop rather than failing over', async () => {
  const controller = new AbortController()
  const run = vi.fn().mockImplementation(async () => {
    controller.abort()
    throw new ProviderError({ status: 504, message: 'aborted', retryable: true })
  })

  await expect(
    execute([candidate('a'), candidate('b')], 'req_1', controller.signal, deps, run),
  ).rejects.toThrow()
  expect(run).toHaveBeenCalledTimes(1)
})

test('an unwrapped SDK error still classifies, via the gateway fallback', async () => {
  // Belt and braces for an adapter that forgets to wrap a call site.
  const run = vi.fn()
    .mockRejectedValueOnce(new OpenAI.APIError(500, { message: 'server error' }, 'server error', undefined))
    .mockResolvedValueOnce('body')

  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
  expect(result.candidate.provider.name).toBe('b')
})

test('each attempt gets its own context carrying that target upstream model', async () => {
  const seen: string[] = []
  const run = vi.fn().mockImplementation(async (_adapter, ctx) => {
    seen.push(ctx.upstreamModel)
    if (seen.length === 1) throw new ProviderError({ status: 500, message: 'x', retryable: true })
    return 'body'
  })

  await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
  expect(seen).toEqual(['a-model', 'b-model'])
})

test('attempts record a latency', async () => {
  const run = vi.fn().mockResolvedValue('body')
  const result = await execute([candidate('a')], 'req_1', live, deps, run)
  expect(result.attempts[0].latencyMs).toBeGreaterThanOrEqual(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/execute.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/execute`.

- [ ] **Step 3: Add `RoutedError`**

Append to `src/lib/gateway/errors.ts`. It has to live here rather than in `execute.ts` because `errors.ts` owns `GatewayError`, and importing `execute.ts` from `errors.ts` would be a cycle:

```ts
/**
 * A gateway error that also carries the attempt chain that produced it, so a
 * failed request can still report which providers were tried and why. The
 * attempt shape is structural rather than imported, to keep errors.ts free of
 * a dependency on the routing loop.
 */
export interface AttemptSummary {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  error?: string
}

export class RoutedError extends GatewayError {
  readonly attempts: AttemptSummary[]
  readonly lastProvider: string | null

  constructor(init: GatewayErrorInit & { attempts: AttemptSummary[]; lastProvider?: string | null }) {
    super(init)
    this.name = 'RoutedError'
    this.attempts = init.attempts
    this.lastProvider = init.lastProvider ?? null
  }
}
```

- [ ] **Step 4: Implement the loop**

Create `src/lib/gateway/execute.ts`:

```ts
import 'server-only'
import type { AttemptContext, ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import {
  RoutedError,
  classifyProviderError,
  type ClassifiedError,
} from './errors'
import type { Candidate } from './resolve'

const DEFAULT_TIMEOUT_MS = 120_000

export interface AttemptRecord {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  /** The classified code and message. Absent when the attempt succeeded. */
  error?: string
}

export interface ExecuteResult<T> {
  value: T
  /** The target that actually served, which under failover is not the first. */
  candidate: Candidate
  attempts: AttemptRecord[]
}

export interface ExecuteDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
}

export function attemptContext(
  candidate: Candidate,
  requestId: string,
  clientSignal: AbortSignal,
): AttemptContext {
  const config = JSON.parse(candidate.provider.config) as { timeoutMs?: number }
  return {
    upstreamModel: candidate.upstreamModel,
    requestId,
    signal: AbortSignal.any([
      clientSignal,
      AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ]),
  }
}

function record(
  index: number,
  candidate: Candidate,
  latencyMs: number,
  classified?: ClassifiedError,
): AttemptRecord {
  return {
    n: index + 1,
    targetId: candidate.targetId,
    provider: candidate.provider.name,
    model: candidate.upstreamModel,
    status: classified?.status ?? 200,
    latencyMs,
    ...(classified
      ? {
          error: classified.code
            ? `${classified.code}: ${classified.message}`
            : classified.message,
        }
      : {}),
  }
}

function routed(
  classified: ClassifiedError,
  attempts: AttemptRecord[],
  candidate: Candidate | undefined,
): RoutedError {
  return new RoutedError({
    status: classified.status,
    type: classified.type,
    code: classified.code,
    message: classified.message,
    attempts,
    lastProvider: candidate?.provider.name ?? null,
  })
}

/**
 * Walks the attempt chain until something succeeds.
 *
 * Generic over `run` so streaming and non-streaming share one loop: the
 * streaming caller passes a `run` that pulls the first chunk, which is what
 * makes the failover boundary and the HTTP commit boundary the same line of
 * code rather than two that have to be kept in step.
 */
export async function execute<T>(
  chain: Candidate[],
  requestId: string,
  clientSignal: AbortSignal,
  deps: ExecuteDeps,
  run: (adapter: ProviderAdapter, ctx: AttemptContext) => Promise<T>,
): Promise<ExecuteResult<T>> {
  const attempts: AttemptRecord[] = []
  let last: RoutedError | undefined

  for (const [index, candidate] of chain.entries()) {
    const startedAt = Date.now()

    let adapter: ProviderAdapter
    try {
      adapter = deps.createAdapter(candidate.provider)
    } catch (err) {
      // A provider the gateway cannot even construct an adapter for — an
      // unimplemented adapter type, or missing credentials — is one target's
      // problem, not the request's. Skip it and let a sibling serve. If the
      // whole chain is unconstructable, `last` still surfaces the real
      // reason (501 unsupported_operation, rather than an opaque 500).
      const classified = classifyProviderError(err)
      attempts.push(record(index, candidate, Date.now() - startedAt, classified))
      last = routed(classified, attempts, candidate)
      continue
    }

    try {
      const value = await run(adapter, attemptContext(candidate, requestId, clientSignal))
      attempts.push(record(index, candidate, Date.now() - startedAt))
      return { value, candidate, attempts }
    } catch (err) {
      const classified = classifyProviderError(err)
      attempts.push(record(index, candidate, Date.now() - startedAt, classified))
      last = routed(classified, attempts, candidate)

      // Failing over onto a request nobody is waiting for wastes an upstream
      // call and, worse, can leave a second provider streaming into a closed
      // socket.
      if (!classified.retryable || clientSignal.aborted) throw last
    }
  }

  // Reached only when every attempt was retryable. The client gets the last
  // provider's actual complaint — three rate-limited providers should read as
  // 429, not as a blanket 502 that clients handle as a gateway bug.
  throw (
    last ??
    new RoutedError({
      status: 503,
      type: 'api_error',
      code: 'no_targets_available',
      message: 'No route targets were available to serve this request.',
      attempts,
    })
  )
}
```

- [ ] **Step 5: Remove the moved function from the handler**

In `src/lib/gateway/chat-handler.ts`, delete the `attemptContext` function (currently lines 48-62) and the now-unused `DEFAULT_TIMEOUT_MS` constant (line 13). Add `attemptContext` to a new import so the file still compiles:

```ts
import { attemptContext } from './execute'
```

Also drop `AttemptContext` from the `@/lib/adapters/types` import if it is now unused. The handler is rewritten wholesale in Task 6; this step only keeps the tree compiling and green in between.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/execute.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`
Expected: PASS — the handler still routes to `candidates[0]` at this point, so no gateway test's behaviour has changed.

- [ ] **Step 8: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): add the attempt loop

execute() walks the chain, classifying each failure into advance-or-stop.
Generic over its run callback so streaming and non-streaming share one
loop, which makes the failover boundary and the HTTP commit boundary the
same line of code. A createAdapter failure skips its target rather than
failing the request; an exhausted chain surfaces the last provider's
actual error rather than a blanket 502."
```

---

### Task 6: Route through the chain

Wires selection and the loop into the handler. This is the task where the three policies start to actually route, and where `tests/gateway/` gains its first multi-target model.

**Files:**
- Modify: `src/lib/gateway/chat-handler.ts`
- Modify: `tests/helpers/gateway.ts` (add a multi-target seed helper)
- Test: `tests/gateway/failover.test.ts` (new)

**Interfaces:**
- Consumes: `selectOrder` (Task 2-4), `execute` / `ExecuteDeps` / `AttemptRecord` (Task 5), `RoutedError` (Task 5).
- Produces:
  - `ChatHandlerDeps` in `@/lib/gateway/chat-handler` is unchanged in shape (`{ createAdapter }`), so every existing test's `fakeAdapterDeps` keeps working.
  - `seedTargets(options)` from `tests/helpers/gateway` — seeds one virtual model with N providers/targets.

- [ ] **Step 1: Add the multi-target seed helper**

Append to `tests/helpers/gateway.ts`:

```ts
export interface TargetSpec {
  /** Provider name, also used to build a distinct upstream model name. */
  name: string
  priority?: number
  weight?: number
  enabled?: boolean
  adapter?: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
}

export interface SeedTargetsOptions {
  virtualModel?: string
  policy?: 'failover' | 'weighted' | 'round_robin'
  maxAttempts?: number
  targets: TargetSpec[]
}

/**
 * Seeds one virtual model fronting several providers. seedGateway covers the
 * single-target case every Phase 1 test uses; this is for routing, where the
 * whole point is which of several targets gets picked.
 */
export async function seedTargets(options: SeedTargetsOptions) {
  const [model] = await db.insert(virtualModels).values({
    name: options.virtualModel ?? 'house-model',
    policy: options.policy ?? 'failover',
    maxAttempts: options.maxAttempts ?? 3,
  }).returning()

  const targets = []
  for (const spec of options.targets) {
    const [provider] = await db.insert(providers).values({
      name: spec.name,
      adapter: spec.adapter ?? 'openai',
      credentials: encryptJson({ apiKey: `sk-${spec.name}` }),
    }).returning()

    const [target] = await db.insert(routeTargets).values({
      virtualModelId: model.id,
      providerId: provider.id,
      upstreamModel: `${spec.name}-model`,
      priority: spec.priority ?? 0,
      weight: spec.weight ?? 100,
      enabled: spec.enabled ?? true,
    }).returning()

    targets.push({ provider, target })
  }

  const generated = generateApiKey()
  const [key] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
  }).returning()

  return { model, targets, key, apiKey: generated.key }
}

/**
 * A deps object whose adapter depends on which provider is being called, so a
 * test can make one target fail and another succeed.
 */
export function fakeAdapterByProvider(
  byName: Record<string, Partial<ProviderAdapter>>,
) {
  return {
    createAdapter: (provider: { name: string }) => ({
      async chat() {
        throw new Error(`chat not stubbed for ${provider.name}`)
      },
      async *chatStream() {
        throw new Error(`chatStream not stubbed for ${provider.name}`)
      },
      ...(byName[provider.name] ?? {}),
    }) as ProviderAdapter,
  }
}
```

`fakeAdapterByProvider` types its parameter as `{ name: string }` rather than `ProviderRow` on purpose. Function parameters are contravariant under `strictFunctionTypes`, and `ProviderRow` is assignable to `{ name: string }`, so this still satisfies `ChatHandlerDeps['createAdapter']` without the helper having to know the whole row.

- [ ] **Step 2: Write the failing tests**

Create `tests/gateway/failover.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { resetCursors } from '@/lib/gateway/rr-cursor'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'f'.repeat(64)
  resetCursors()
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('failover walks to the next target when the first is retryably down', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
    }),
  )

  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe('backup')
})

test('the response headers name the target that actually served', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('backup-model')
})

test('a fatal error from the first target is not failed over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })
  const backupChat = vi.fn().mockResolvedValue(completion('backup'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(400, 'context_length_exceeded')) },
      backup: { chat: backupChat },
    }),
  )

  expect(res.status).toBe(400)
  expect(backupChat).not.toHaveBeenCalled()
})

test('an exhausted chain returns the last provider error', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(500, 'server error')) },
      b: { chat: vi.fn().mockRejectedValue(apiError(429, 'slow down')) },
    }),
  )

  expect(res.status).toBe(429)
  expect((await res.json()).error.message).toContain('slow down')
})

test('max_attempts caps how many targets are tried', async () => {
  const { apiKey } = await seedTargets({
    maxAttempts: 2,
    targets: [
      { name: 'a', priority: 0 }, { name: 'b', priority: 1 }, { name: 'c', priority: 2 },
    ],
  })
  const cChat = vi.fn().mockResolvedValue(completion('c'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      b: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      c: { chat: cChat },
    }),
  )

  expect(res.status).toBe(503)
  expect(cChat).not.toHaveBeenCalled()
})

test('a disabled target is never in the chain', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'off', priority: 0, enabled: false }, { name: 'on', priority: 1 }],
  })
  const offChat = vi.fn()

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      off: { chat: offChat },
      on: { chat: vi.fn().mockResolvedValue(completion('on')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(offChat).not.toHaveBeenCalled()
})

test('an unimplemented adapter type is skipped rather than failing the model', async () => {
  // A gemini target sitting beside a healthy openai one must not break the
  // model. Uses the real registry, since the skip depends on createAdapter
  // actually throwing.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'gem', priority: 0, adapter: 'gemini' },
      { name: 'oai', priority: 1 },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    {
      createAdapter: (provider) => {
        if (provider.adapter === 'gemini') {
          throw new UnsupportedOperationError('the "gemini" adapter is not available yet.')
        }
        return { chat: async () => completion('oai') } as never
      },
    },
  )

  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe('oai')
})

test('round robin spreads successive requests across targets', async () => {
  const { apiKey } = await seedTargets({
    policy: 'round_robin',
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })
  const deps = fakeAdapterByProvider({
    a: { chat: vi.fn().mockResolvedValue(completion('a')) },
    b: { chat: vi.fn().mockResolvedValue(completion('b')) },
  })

  const first = await handleChatCompletions(chatRequest(body, apiKey), deps)
  const second = await handleChatCompletions(chatRequest(body, apiKey), deps)
  const third = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(first.headers.get('x-babellm-provider')).toBe('a')
  expect(second.headers.get('x-babellm-provider')).toBe('b')
  expect(third.headers.get('x-babellm-provider')).toBe('a')
})

test('weighted routing sends everything to the only positively-weighted target', async () => {
  // A deterministic weighted case that needs no RNG injection: with one
  // target at weight 0 it can never be drawn first.
  const { apiKey } = await seedTargets({
    policy: 'weighted',
    targets: [{ name: 'never', weight: 0 }, { name: 'always', weight: 100 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      never: { chat: vi.fn() },
      always: { chat: vi.fn().mockResolvedValue(completion('always')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('always')
})

test('a stream that fails before its first chunk fails over silently', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const failing = async function* () {
    throw apiError(503, 'down')
    yield undefined as never
  }
  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'backup-model',
      choices: [{ index: 0, delta: { content: 'from backup' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      primary: { chatStream: failing as never },
      backup: { chatStream: working as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  const text = await res.text()
  expect(parseSseChunks(text)).toHaveLength(1)
  expect(sseTerminated(text)).toBe(true)
})

test('a stream that fails after its first chunk is not failed over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })
  const backupStream = vi.fn()

  const halfway = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'primary-model',
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    }
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      primary: { chatStream: halfway as never },
      backup: { chatStream: backupStream as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('primary')
  await res.text()
  expect(backupStream).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/gateway/failover.test.ts`
Expected: FAIL — every multi-target test fails because the handler still uses `candidates[0]`; the round-robin and header tests report `primary`/`a` where a different provider was expected.

- [ ] **Step 4: Rewrite the handler to route**

Replace `src/lib/gateway/chat-handler.ts` in full:

```ts
import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter } from '@/lib/adapters/registry'
import type { ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { chatCompletionRequestSchema } from '@/lib/schemas/chat'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { GatewayError, RoutedError, errorResponse } from './errors'
import { execute } from './execute'
import { newCompletionId, rewriteCompletion } from './identity'
import { resolveVirtualModel, type Candidate } from './resolve'
import { selectOrder } from './select'
import { sseResponse, startChatStream } from './sse'

export interface ChatHandlerDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
}

const defaultDeps: ChatHandlerDeps = { createAdapter: defaultCreateAdapter }

async function parseBody(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      message: 'Request body could not be parsed as JSON.',
    })
  }

  const result = chatCompletionRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = (result.error as z.ZodError).issues[0]
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param: issue.path.length > 0 ? String(issue.path[0]) : null,
      message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
    })
  }
  return result.data
}

export function attemptHeaders(candidate: Candidate, requestId: string): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
  }
}

export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    const body = await parseBody(request)
    const { model, candidates } = await resolveVirtualModel(body.model)
    const chain = selectOrder(candidates, model)

    void touchApiKey(apiKey.id).catch((err) =>
      console.error(`[gateway] failed to update last_used_at request_id=${requestId}`, err),
    )

    const identity = { id: newCompletionId(), model: body.model }

    if (body.stream) {
      // startChatStream pulls the first chunk, so a failure inside `run` is
      // still a failure before the response is committed — which is what
      // makes failover safe for streams.
      const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
        startChatStream(adapter.chatStream(body, ctx)),
      )
      return sseResponse(result.value, identity, attemptHeaders(result.candidate, requestId))
    }

    const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
      adapter.chat(body, ctx),
    )

    return Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId),
    })
  } catch (err) {
    // Under failover the interesting provider is the last one tried, which
    // only the routed error knows.
    const headers =
      err instanceof RoutedError && err.lastProvider
        ? { 'x-request-id': requestId, 'x-babellm-provider': err.lastProvider }
        : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
```

Note the deliberate change: on an error the response no longer carries `x-babellm-upstream-model`. Under failover several upstream models may have been tried, so a single header would have to lie about one of them; the provider name of the last attempt is the honest subset.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pnpm test tests/gateway/failover.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: PASS, except possibly `tests/gateway/chat.test.ts`'s error-path assertions, which only check status/body and not the dropped header. If any test asserts `x-babellm-upstream-model` on an *error* response, update that assertion to `x-babellm-provider` and note why in the test.

- [ ] **Step 7: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): route through the whole target chain

policy, weight and max_attempts stop being decorative: the handler now
orders every eligible target and walks it. Streams share the loop, so a
stream that dies before its first chunk fails over invisibly while one
that dies after it stays locked to its target.

Error responses now name the last provider tried instead of a provider
plus one upstream model, which under failover could only be true of one
of several attempts."
```

---

### Task 7: The request log line

One JSON line per settled request. The builder is pure so its shape can be asserted without capturing stdout, and `emitRequestLog` never throws — a logging failure must not fail a request that succeeded.

**Files:**
- Create: `src/lib/gateway/request-log.ts`
- Test: `tests/lib/gateway/request-log.test.ts` (new)

**Interfaces:**
- Consumes: `AttemptRecord` from `@/lib/gateway/execute` (Task 5).
- Produces:
  - `type RequestOutcome = 'ok' | 'error' | 'client_closed' | 'stream_interrupted'` from `@/lib/gateway/request-log`.
  - `interface RequestLogFields { requestId: string; key: string | null; model: string | null; stream: boolean; status: number; outcome: RequestOutcome; latencyMs: number; ttftMs?: number; attempts: AttemptRecord[] }`.
  - `buildRequestLog(fields: RequestLogFields): Record<string, unknown>`.
  - `emitRequestLog(fields: RequestLogFields): void`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/gateway/request-log.test.ts`:

```ts
import { afterEach, expect, test, vi } from 'vitest'
import { buildRequestLog, emitRequestLog } from '@/lib/gateway/request-log'
import type { AttemptRecord } from '@/lib/gateway/execute'

function attempt(patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    n: 1,
    targetId: 'target-a',
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 200,
    latencyMs: 120,
    ...patch,
  }
}

function fields(patch: Partial<Parameters<typeof buildRequestLog>[0]> = {}) {
  return {
    requestId: 'req_a1b2',
    key: 'prod-app',
    model: 'gpt-fast',
    stream: false,
    status: 200,
    outcome: 'ok' as const,
    latencyMs: 1042,
    attempts: [attempt()],
    ...patch,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('the line carries the request identity and outcome in snake_case', () => {
  expect(buildRequestLog(fields())).toMatchObject({
    lvl: 'info',
    msg: 'gateway.request',
    request_id: 'req_a1b2',
    key: 'prod-app',
    model: 'gpt-fast',
    stream: false,
    status: 200,
    outcome: 'ok',
    latency_ms: 1042,
  })
})

test('attempts are flattened to the fields a reader needs', () => {
  const line = buildRequestLog(fields({
    attempts: [
      attempt({ n: 1, provider: 'openai', status: 429, latencyMs: 212, error: 'rate_limit_exceeded: slow down' }),
      attempt({ n: 2, provider: 'groq', model: 'llama-3.3-70b', status: 200, latencyMs: 830 }),
    ],
  }))

  expect(line.attempts).toEqual([
    { n: 1, provider: 'openai', model: 'gpt-4o-mini', status: 429, latency_ms: 212, error: 'rate_limit_exceeded: slow down' },
    { n: 2, provider: 'groq', model: 'llama-3.3-70b', status: 200, latency_ms: 830 },
  ])
})

test('ttft is present only for a stream that produced one', () => {
  expect(buildRequestLog(fields())).not.toHaveProperty('ttft_ms')
  expect(buildRequestLog(fields({ stream: true, ttftMs: 310 }))).toMatchObject({ ttft_ms: 310 })
})

test.each([
  [200, 'ok', 'info'],
  [404, 'error', 'warn'],
  [429, 'error', 'warn'],
  [502, 'error', 'error'],
])('status %s logs at %s', (status, outcome, lvl) => {
  expect(buildRequestLog(fields({ status, outcome: outcome as never })).lvl).toBe(lvl)
})

test('an interrupted stream logs at error despite its 200', () => {
  // The status was committed with the first chunk, so it cannot report what
  // happened after it. That is the whole reason `outcome` exists.
  const line = buildRequestLog(fields({ status: 200, outcome: 'stream_interrupted' }))
  expect(line.lvl).toBe('error')
})

test('a client disconnect is not an error', () => {
  expect(buildRequestLog(fields({ status: 200, outcome: 'client_closed' })).lvl).toBe('info')
})

test('an unauthenticated request logs a null key rather than omitting it', () => {
  const line = buildRequestLog(fields({ key: null, model: null, status: 401, outcome: 'error' }))
  expect(line.key).toBeNull()
  expect(line.model).toBeNull()
})

test('the log never carries anything key-shaped', () => {
  // `key` is the API key's *name*. A regression here would write bearer
  // tokens into whatever aggregates stdout.
  const serialized = JSON.stringify(buildRequestLog(fields({ key: 'prod-app' })))
  expect(serialized).not.toContain('sk-bab-')
})

test('emit writes exactly one line of JSON', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  emitRequestLog(fields())

  expect(log).toHaveBeenCalledTimes(1)
  const written = log.mock.calls[0][0] as string
  expect(written).not.toContain('\n')
  expect(JSON.parse(written).msg).toBe('gateway.request')
})

test('a failure to emit never escapes', () => {
  // A request that succeeded must not be turned into a failure by logging.
  const log = vi.spyOn(console, 'log').mockImplementation(() => {
    throw new Error('stdout is gone')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(() => emitRequestLog(fields())).not.toThrow()
  expect(log).toHaveBeenCalled()
  expect(error).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/gateway/request-log.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/request-log`.

- [ ] **Step 3: Implement the log**

Create `src/lib/gateway/request-log.ts`:

```ts
import type { AttemptRecord } from './execute'

export type RequestOutcome = 'ok' | 'error' | 'client_closed' | 'stream_interrupted'

export interface RequestLogFields {
  requestId: string
  /** The API key's *name*. Never the key, its prefix, or its hash. */
  key: string | null
  /** The virtual model the client asked for. Null if the request never parsed. */
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  latencyMs: number
  /** Streaming only: time to the first chunk. */
  ttftMs?: number
  attempts: AttemptRecord[]
}

function level(fields: RequestLogFields): 'info' | 'warn' | 'error' {
  // A stream that dies after its first chunk has already committed a 200, so
  // the status alone would report a failed request as a success.
  if (fields.outcome === 'stream_interrupted' || fields.status >= 500) return 'error'
  if (fields.status >= 400) return 'warn'
  return 'info'
}

/**
 * The one place a request log line is shaped. Snake_case throughout, because
 * the consumer is a log aggregator rather than TypeScript.
 *
 * `targetId` is deliberately dropped: it is a uuid nobody can resolve without
 * the database, and the provider/model pair identifies the attempt for anyone
 * reading stdout.
 */
export function buildRequestLog(fields: RequestLogFields): Record<string, unknown> {
  return {
    lvl: level(fields),
    msg: 'gateway.request',
    request_id: fields.requestId,
    key: fields.key,
    model: fields.model,
    stream: fields.stream,
    status: fields.status,
    outcome: fields.outcome,
    latency_ms: fields.latencyMs,
    ...(fields.ttftMs === undefined ? {} : { ttft_ms: fields.ttftMs }),
    attempts: fields.attempts.map((attempt) => ({
      n: attempt.n,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latency_ms: attempt.latencyMs,
      ...(attempt.error ? { error: attempt.error } : {}),
    })),
  }
}

/**
 * Writes one line to stdout. Never throws: a request that succeeded must not
 * be turned into a failure by its own logging.
 */
export function emitRequestLog(fields: RequestLogFields): void {
  try {
    console.log(JSON.stringify(buildRequestLog(fields)))
  } catch (err) {
    console.error(`[gateway] failed to emit request log request_id=${fields.requestId}`, err)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/gateway/request-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): add the structured request log line

One JSON line per settled request, carrying the whole attempt chain.
outcome is separate from status because a stream that dies after its
first chunk has already committed a 200. The emitter never throws — a
request that succeeded must not be failed by its own logging."
```

---

### Task 8: Emit the log on every settled request

Wires the log into the handler, including the streaming path — where "settled" means the stream closed, not the response returned. `sseResponse` gains an `onSettle` callback that fires exactly once, from whichever of the three paths gets there first.

Time-to-first-token needs no plumbing into `sse.ts`: `startChatStream` pulls chunk #1, so by the time `execute` resolves for a stream the first chunk is already in hand.

**Files:**
- Modify: `src/lib/gateway/sse.ts`
- Modify: `src/lib/gateway/chat-handler.ts`
- Modify: `tests/gateway/chat.test.ts` (silence the new stdout line)
- Modify: `tests/gateway/chat-stream.test.ts` (silence the new stdout line)
- Test: `tests/gateway/request-log.test.ts` (new)

**Interfaces:**
- Consumes: `emitRequestLog`, `RequestLogFields`, `RequestOutcome` (Task 7); `RoutedError` (Task 5); `AttemptRecord` (Task 5).
- Produces:
  - `type StreamOutcome = 'ok' | 'client_closed' | 'stream_interrupted'` from `@/lib/gateway/sse`.
  - `sseResponse(started, identity, headers, onSettle?: (outcome: StreamOutcome) => void)` — the fourth parameter is optional, so no existing call site breaks.

- [ ] **Step 1: Write the failing tests**

Create `tests/gateway/request-log.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

let lines: Array<Record<string, unknown>>

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  lines = []
  vi.spyOn(console, 'log').mockImplementation((written: unknown) => {
    // Defensive: anything else that reaches stdout during a test would
    // otherwise throw inside the spy and fail the test for the wrong reason.
    try {
      lines.push(JSON.parse(written as string))
    } catch {
      // not a gateway log line; ignore
    }
  })
})

/** Waits for the stream's settle callback, which fires after the body drains. */
async function drain(res: Response) {
  await res.text()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('a successful request logs exactly one line', async () => {
  const { apiKey } = await seedGateway()
  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    msg: 'gateway.request',
    model: 'house-model',
    key: 'test key',
    status: 200,
    outcome: 'ok',
    stream: false,
  })
})

test('the line records every attempt made, in order', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { chat: vi.fn().mockResolvedValue(upstreamCompletion) },
    }),
  )

  const attempts = lines[0].attempts as Array<Record<string, unknown>>
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ n: 1, provider: 'primary', status: 503 })
  expect(attempts[1]).toMatchObject({ n: 2, provider: 'backup', status: 200 })
})

test('a failed request still logs its attempts', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(500)) },
      b: { chat: vi.fn().mockRejectedValue(apiError(429)) },
    }),
  )

  expect(lines[0]).toMatchObject({ status: 429, outcome: 'error', lvl: 'warn' })
  expect(lines[0].attempts).toHaveLength(2)
})

test('a rejected request with no key logs a null key and no attempts', async () => {
  await seedGateway()
  await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))

  expect(lines[0]).toMatchObject({ key: null, status: 401, outcome: 'error' })
  expect(lines[0].attempts).toEqual([])
})

test('a streaming request logs once, on stream close, with a ttft', async () => {
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
  expect(lines).toHaveLength(0)

  await drain(res)

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ stream: true, status: 200, outcome: 'ok' })
  expect(lines[0].ttft_ms).toBeGreaterThanOrEqual(0)
})

test('a mid-stream failure logs stream_interrupted at error despite the 200', async () => {
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
  await drain(res)

  expect(lines[0]).toMatchObject({ status: 200, outcome: 'stream_interrupted', lvl: 'error' })
})

test('a client disconnect logs client_closed exactly once', async () => {
  const { apiKey } = await seedGateway()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })

  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
    }
    await gate
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )

  const reader = res.body!.getReader()
  await reader.read()
  await reader.cancel()
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ outcome: 'client_closed' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/gateway/request-log.test.ts`
Expected: FAIL — `lines` is empty; nothing writes a log line yet.

- [ ] **Step 3: Add `onSettle` to `sseResponse`**

In `src/lib/gateway/sse.ts`, add above `sseResponse`:

```ts
export type StreamOutcome = 'ok' | 'client_closed' | 'stream_interrupted'
```

Change the signature to take a fourth optional parameter and add the settle guard. Replace the body of `sseResponse` with:

```ts
export function sseResponse(
  started: StartedChatStream,
  identity: IdentityOptions,
  headers: HeadersInit,
  onSettle?: (outcome: StreamOutcome) => void,
): Response {
  // Set the moment the client disconnects. The `for await` below may still
  // be mid-pull when that happens (it does not know the controller is gone
  // until it tries to enqueue), so every enqueue site checks this before
  // touching the controller — a ReadableStreamController that has been
  // cancelled throws on `enqueue`, and an uncaught throw here would surface
  // as an unhandled rejection.
  let cancelled = false

  // A cancelled stream reaches both cancel() and the generator's finally, so
  // the callback needs a first-one-wins guard or a disconnect would log
  // twice — once as client_closed and once as ok.
  let settled = false
  function settle(outcome: StreamOutcome) {
    if (settled) return
    settled = true
    try {
      onSettle?.(outcome)
    } catch (err) {
      console.error('[gateway] stream settle callback failed', err)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of started.chunks) {
          if (cancelled) return
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
      } catch (err) {
        if (cancelled) return
        const classified = classifyProviderError(err)
        settle('stream_interrupted')
        controller.enqueue(
          event({
            error: {
              message: classified.message,
              type: classified.type,
              param: null,
              code: 'stream_interrupted',
            },
          }),
        )
      } finally {
        if (!cancelled) {
          settle('ok')
          controller.enqueue(DONE)
          controller.close()
        }
      }
    },
    cancel() {
      cancelled = true
      settle('client_closed')
      // Ask the source iterator to run its cleanup (e.g. release the
      // upstream fetch) instead of leaving it to keep being pulled by
      // nobody. Without this, a client disconnect only stops progress
      // incidentally — via whatever AbortSignal the adapter happens to
      // wire up — rather than as a guaranteed consequence of cancellation.
      void started.iterator.return?.()
    },
  })

  return new Response(stream, {
    headers: {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
```

- [ ] **Step 4: Emit the line from the handler**

In `src/lib/gateway/chat-handler.ts`, add to the imports:

```ts
import type { AttemptRecord } from './execute'
import { emitRequestLog, type RequestOutcome } from './request-log'
```

Then rewrite `handleChatCompletions`:

```ts
export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')
  const startedAt = Date.now()

  // Tracked outside the try so the log line can still say who was calling
  // and for what when the request never got as far as an attempt.
  let keyName: string | null = null
  let modelName: string | null = null
  let stream = false

  function log(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    ttftMs?: number,
  ) {
    emitRequestLog({
      requestId,
      key: keyName,
      model: modelName,
      stream,
      status,
      outcome,
      latencyMs: Date.now() - startedAt,
      ...(ttftMs === undefined ? {} : { ttftMs }),
      attempts,
    })
  }

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    keyName = apiKey.name
    const body = await parseBody(request)
    modelName = body.model
    stream = body.stream === true

    const { model, candidates } = await resolveVirtualModel(body.model)
    const chain = selectOrder(candidates, model)

    void touchApiKey(apiKey.id).catch((err) =>
      console.error(`[gateway] failed to update last_used_at request_id=${requestId}`, err),
    )

    const identity = { id: newCompletionId(), model: body.model }

    if (stream) {
      // startChatStream pulls the first chunk, so a failure inside `run` is
      // still a failure before the response is committed — which is what
      // makes failover safe for streams.
      const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
        startChatStream(adapter.chatStream(body, ctx)),
      )
      // execute resolves only once the first chunk is in hand, so this is
      // time-to-first-token without any plumbing into the stream itself.
      const ttftMs = Date.now() - startedAt

      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId),
        (outcome) => log(200, outcome, result.attempts, ttftMs),
      )
    }

    const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
      adapter.chat(body, ctx),
    )

    log(200, 'ok', result.attempts)
    return Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId),
    })
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500
    log(status, 'error', err instanceof RoutedError ? err.attempts : [])

    // Under failover the interesting provider is the last one tried, which
    // only the routed error knows.
    const headers =
      err instanceof RoutedError && err.lastProvider
        ? { 'x-request-id': requestId, 'x-babellm-provider': err.lastProvider }
        : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
```

`RoutedError.attempts` is typed as `AttemptSummary[]` in `errors.ts` and `AttemptRecord[]` here; they are the same structural shape, so the assignment type-checks. If TypeScript objects, change `emitRequestLog`'s `attempts` parameter type to `AttemptSummary[]` and import it from `./errors` — do not widen it to `unknown[]`.

- [ ] **Step 5: Silence the new stdout line in the existing gateway tests**

Every gateway test now writes a JSON line to stdout, which buries real test output. Add to the `beforeEach` in both `tests/gateway/chat.test.ts` and `tests/gateway/chat-stream.test.ts`:

```ts
  vi.spyOn(console, 'log').mockImplementation(() => {})
```

`chat.test.ts` already imports `vi`. Both files need an `afterEach(() => { vi.restoreAllMocks() })` if they do not already have one — `chat-stream.test.ts` does not, so add it after the `beforeEach`.

Do the same in `tests/contract/openai-client.test.ts` if it drives the handler directly.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm test tests/gateway/request-log.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add -A
git commit -m "feat(gateway): emit one request log line per settled request

Streams settle when the stream closes rather than when the response is
returned, so sseResponse gained a first-one-wins onSettle callback: a
disconnect reaches both cancel() and the generator's finally, and would
otherwise log twice.

ttft needs no plumbing into the stream — startChatStream already pulls
the first chunk, so execute resolving *is* first token."
```

---

### Task 9: Documentation and phase handoff

The README describes single-target routing and says the policy column is not honoured. Both are now false. Phase 2 also carries forward findings the way Phases 1 and 1.5 did.

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/phase-2-handoff.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Find what the README claims about routing**

Run: `grep -n -i "policy\|routing\|failover\|weight\|round.robin\|target" README.md`

Read every hit. The README was written for Phase 1, where `candidates[0]` was the whole router.

- [ ] **Step 2: Correct the README**

Update the routing description so it states:

- All three policies (`failover`, `weighted`, `round_robin`) are honoured.
- `max_attempts` bounds the chain.
- A retryable failure fails over; a fatal one does not.
- Streams fail over up to their first chunk and are locked in after it.
- There is no circuit breaker yet, so a hard-down provider costs one wasted attempt per request.
- Round-robin state is per-process, so it skews if more than one instance is run.
- Each request writes one JSON line to stdout; there is no request history in the database.

Do not invent features. If a sentence in the README is still true, leave it alone.

- [ ] **Step 3: Write the handoff**

Create `docs/superpowers/phase-2-handoff.md` following the structure of `docs/superpowers/phase-1-5-handoff.md`:

- A header line with the date, commit count, test count, and the state of `tsc` / `lint` / `build`.
- **Decide before Phase 3.** The Phase 1 handoff's error-classification question is now answered — say so, and say that each new adapter must ship its own `toProviderError` alongside it. Note that `classifyProviderError`'s legacy `OpenAI.APIError` branch is now a fallback, and should be deleted once every adapter wraps its own errors.
- **Deferred by decision, not oversight.** The circuit breaker and `target_health`; `request_logs`, `request_payloads` and the `/logs` viewer; the `rr_cursors` table. For each: what was decided and what it costs to run without it. Quote the "Known limitations" section of the spec rather than re-deriving it.
- **Carried forward** — anything the implementation surfaced and did not fix, in rough priority order.
- **Never verified** — anything no test covers. At minimum: no failover has been exercised against two *real* providers; the stdout line has never been read by a log aggregator.
- **Still open from earlier phases** — re-check the Phase 1 handoff's "Still open after Phase 1" section (admin auth hardening) and the Phase 1.5 handoff's concurrency items, and carry forward whatever is still true.

- [ ] **Step 4: Verify the whole suite one last time**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build`
Expected: all four PASS. Record the test count for the handoff header.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: phase 2 handoff and README routing correction

The README described single-target routing and said the policy column
was not honoured; both stopped being true this phase. The handoff
carries forward what the work surfaced and did not fix, and records
the breaker, request_logs and rr_cursors as deferred by decision."
```

---

## Verification

After Task 9, the following must all hold. Check each explicitly rather than assuming:

- [ ] `pnpm test` passes, with no test file edited except as a task instructed.
- [ ] `pnpm exec tsc --noEmit` is clean.
- [ ] `pnpm lint` is clean.
- [ ] `pnpm build` succeeds.
- [ ] `git status` shows a clean tree.
- [ ] `drizzle/` is untouched — `git log --stat` for this branch shows no migration file and no `src/lib/db/schema.ts` change.
- [ ] `grep -n "target_health\|rr_cursors\|request_logs" src/lib/db/schema.ts` returns nothing. (`rr-cursor.ts` mentions `rr_cursors` in a comment explaining why it does *not* use one; that is the only permitted hit anywhere in `src/`.)
