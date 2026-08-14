# DynamoDB Request Log Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dynamodb` as a second, readable `RequestLogStore` driver alongside `postgres`.

**Architecture:** One DynamoDB table, sixteen shards keyed on the uuid v7's last hex character, with the id itself as the sort key. Because a v7 sorts chronologically, a time range is a sort-key condition — so `get()` is a single `GetItem`, cursors stay plain uuids, and the admin layer needs no changes. Non-time filters ride a `FilterExpression` over a bounded, budget-capped fan-out and merge.

**Tech Stack:** TypeScript, Next.js 16, `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`, Vitest, DynamoDB Local via Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-14-dynamodb-request-log-store-design.md`

## Global Constraints

- **`SHARDS = 16` is immutable.** `get()` derives the shard from the id, so changing it makes existing items unreachable by detail lookup. Never a setting, never an env var.
- **Never run tests against port 5432.** The disposable Postgres is on **5434**, Redis on **6380**, DynamoDB Local on **8001**. Start with `pnpm test:db:up`.
- **`.env.test` is gitignored.** Create it with `cp .env.test.example .env.test`.
- **The DynamoDB driver must not register during the test suite.** Its enable switch is `DYNAMODB_LOGS_TABLE`; tests use `TEST_DYNAMODB_TABLE` / `TEST_DYNAMODB_ENDPOINT` instead and construct the store directly. This mirrors the existing `TEST_REDIS_URL` precedent in `.env.test.example`.
- **Payload limits:** `DYNAMO_PAYLOAD_MAX_BYTES = 150 * 1024` per side; `ITEM_MAX_BYTES = 380 * 1024` for the assembled item.
- **Budget:** `MAX_ROUND_TRIPS = 8`, `MAX_ITEMS_EXAMINED = 10_000`.
- **Costs are strings.** `inputCostUsd`, `cachedCostUsd`, `outputCostUsd`, `costUsd` are DynamoDB `S`, never `N`.
- **Model clamp:** 128 characters, matching `postgres.ts`.
- Run `pnpm typecheck` and `pnpm lint` before every commit.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/logs/months.ts` | `monthStart` / `addMonths` — pure month arithmetic, shared by partitions and TTL |
| `src/lib/logs/dynamodb/keys.ts` | `SHARDS`, `SHARD_KEYS`, `shardKey()`, `boundsFor()` |
| `src/lib/logs/dynamodb/item.ts` | `toItem()`, `toRow()`, `toDetail()`, `expiresAtFor()` — all pure |
| `src/lib/logs/dynamodb/merge.ts` | `collectPage()` — the k-way shard merge, client-agnostic |
| `src/lib/logs/dynamodb/index.ts` | `createDynamoStore()`, `dynamodbStore` — the only file that talks to AWS |
| `tests/helpers/dynamo.ts` | `createLogsTable()`, `resetLogsTable()`, `testDynamoConfig()` |
| `tests/lib/logs/store-contract.ts` | Driver-agnostic contract suite run by both drivers |

Splitting the driver into four files rather than one keeps the risky algorithm (`merge.ts`) and the mapping rules (`item.ts`) testable **without a container**, which is the difference between a fast unit test and a Docker dependency.

**Dependency order:** Tasks 1 → 2 → 3 → 4 → 5 are pure and fast. Task 6 (infrastructure) depends on nothing and may be run in parallel with 1–5. Tasks 7 → 8 → 9 are sequential.

---

### Task 1: Extract month arithmetic

`monthStart` and `addMonths` are pure month arithmetic that the DynamoDB TTL needs. Importing them from a module named "partitions" into a driver with no partitions would misdescribe both.

**Files:**
- Create: `src/lib/logs/months.ts`
- Modify: `src/lib/logs/partitions.ts` (remove the two functions, re-export from the new module)
- Test: `tests/lib/logs/months.test.ts` (new), `tests/lib/logs/partitions.test.ts` (move the relevant tests)

**Interfaces:**
- Consumes: nothing
- Produces: `monthStart(date: Date): Date`, `addMonths(date: Date, count: number): Date`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/months.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { addMonths, monthStart } from '@/lib/logs/months'

test('monthStart truncates to the first instant of the month in UTC', () => {
  expect(monthStart(new Date('2026-08-14T16:13:00Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('monthStart never uses the local zone', () => {
  // 23:30 on the 31st in UTC+2 is still the 31st in UTC. A local-zone
  // implementation would put the same instant in different months on
  // instances deployed to different regions.
  expect(monthStart(new Date('2026-08-31T21:30:00Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('addMonths works from the truncated month, not the given day', () => {
  // Date.UTC(2026, 1, 31) is 3 March. Truncating first is what stops a
  // caller passing the 31st from landing two months out.
  expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString())
    .toBe('2026-02-01T00:00:00.000Z')
})

test('addMonths crosses year boundaries in both directions', () => {
  expect(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString())
    .toBe('2027-02-01T00:00:00.000Z')
  expect(addMonths(new Date('2026-02-15T00:00:00Z'), -3).toISOString())
    .toBe('2025-11-01T00:00:00.000Z')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/months.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/months`

- [ ] **Step 3: Create the module**

Create `src/lib/logs/months.ts`:

```typescript
/** The first instant of `date`'s month, in UTC. Never the local zone: a
 * month boundary that moved with a deployment's timezone would put the same
 * row in different months on different instances. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

/** Month arithmetic on the truncated month, so a caller passing the 31st
 * cannot land two months out — Date.UTC(2026, 1, 31) is 3 March. */
export function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
}
```

- [ ] **Step 4: Point partitions.ts at the new module**

In `src/lib/logs/partitions.ts`, delete the `monthStart` and `addMonths` function bodies and their doc comments, then add near the other imports:

```typescript
import { addMonths, monthStart } from './months'
```

and, so existing importers keep working unchanged:

```typescript
export { addMonths, monthStart } from './months'
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS — 878 tests (874 existing + 4 new), 0 failures. `tests/helpers/db.ts` and `tests/lib/logs/partitions.test.ts` import `addMonths` from `partitions`, and the re-export keeps them green.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/months.ts src/lib/logs/partitions.ts tests/lib/logs/months.test.ts
git commit -m "refactor(logs): extract month arithmetic into its own module"
```

---

### Task 2: Widen the write contract to carry settings

TTL must be stamped on the item at write time, and `write(entry)` has no access to `retentionMonths`.

**Files:**
- Modify: `src/lib/logs/types.ts` (the `BaseSink.write` signature)
- Modify: `src/lib/logs/index.ts:14` (`logRequest`)
- Modify: `src/lib/logs/postgres.ts` (accept and ignore the second argument)
- Test: `tests/lib/logs/write-settings.test.ts` (new)

**Interfaces:**
- Consumes: `LoggingSettings` from `@/lib/settings`
- Produces: `write(entry: RequestLogEntry, settings: LoggingSettings): Promise<void>` on every store

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/write-settings.test.ts`:

```typescript
import { afterEach, expect, test } from 'vitest'
import { DRIVERS, clearRequestLogStoreCache, logRequest } from '@/lib/logs'
import { setLoggingSettings } from '@/lib/settings'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings, RequestLogEntry, WriteOnlySink } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

const DRIVER = 'test-settings-capture'
let captured: LoggingSettings | null = null

const sink: WriteOnlySink = {
  name: DRIVER,
  readable: false,
  async write(_entry, settings) { captured = settings },
  async maintain() { return { created: [], dropped: [] } },
}

afterEach(async () => {
  delete DRIVERS[DRIVER]
  clearRequestLogStoreCache()
  captured = null
  await resetDb()
})

function entry(): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: null, model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
  }
}

test('logRequest hands the resolved logging settings to the store', async () => {
  await resetDb()
  DRIVERS[DRIVER] = sink
  await setLoggingSettings({ store: DRIVER, retentionMonths: 7 })
  clearRequestLogStoreCache()

  await logRequest(entry())

  // The settings come from the same cached resolution that picked the store,
  // so a driver that needs them (DynamoDB stamps a TTL from retentionMonths)
  // costs no extra query to get them.
  expect(captured?.retentionMonths).toBe(7)
  expect(captured?.store).toBe(DRIVER)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/write-settings.test.ts`
Expected: FAIL — TypeScript reports `write` takes 1 argument, and `captured` is null.

- [ ] **Step 3: Widen the interface**

`src/lib/logs/types.ts` already imports `LoggingSettings` on line 1, so no import
change is needed. Change `BaseSink.write`:

```typescript
interface BaseSink {
  readonly name: string
  /** `settings` comes from the same cached resolution that selected this
   * store, so a driver that needs it — DynamoDB stamps its TTL from
   * `retentionMonths` — pays no extra query for it. Drivers that do not
   * need it ignore the argument. */
  write(entry: RequestLogEntry, settings: LoggingSettings): Promise<void>
```

- [ ] **Step 4: Thread settings through logRequest**

In `src/lib/logs/index.ts`, replace the body of `logRequest`:

```typescript
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const { store, settings } = await resolveRequestLogStore()
  await store.write(entry, settings)
}
```

and update the import at the top of the file from `getRequestLogStore` to `resolveRequestLogStore`:

```typescript
import { resolveRequestLogStore } from './registry'
```

- [ ] **Step 5: Update the Postgres driver's signature**

In `src/lib/logs/postgres.ts`, change the `write` signature. It has no use for the argument, and the underscore says so:

```typescript
  async write(entry: RequestLogEntry, _settings: LoggingSettings): Promise<void> {
```

`LoggingSettings` is already imported in that file for `maintain`.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS. The `writeOnlySink` double in `tests/helpers/logs.ts:42` is `async write() {}`, which is assignable to the wider signature and needs no change.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/types.ts src/lib/logs/index.ts src/lib/logs/postgres.ts tests/lib/logs/write-settings.test.ts
git commit -m "feat(logs): pass logging settings to store writes"
```

---

### Task 3: Shard keys and query bounds

Pure functions, no AWS. This is where the immutable shard count and the `BETWEEN`-exclusivity rule live.

**Files:**
- Create: `src/lib/logs/dynamodb/keys.ts`
- Test: `tests/lib/logs/dynamodb/keys.test.ts`

**Interfaces:**
- Consumes: `uuidv7Bound` from `@/lib/uuid`, `LogFilter` from `../types`
- Produces:
  - `SHARDS: 16`, `SHARD_KEYS: readonly string[]`, `MIN_UUID: string`, `MAX_UUID: string`
  - `shardKey(id: string): string`
  - `boundsFor(filter: LogFilter): { lo: string; hi: string; exclude: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/dynamodb/keys.test.ts`:

```typescript
import { expect, test } from 'vitest'
import {
  MAX_UUID, MIN_UUID, SHARDS, SHARD_KEYS, boundsFor, shardKey,
} from '@/lib/logs/dynamodb/keys'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'

test('there are sixteen shard keys, one per hex digit', () => {
  expect(SHARDS).toBe(16)
  expect(SHARD_KEYS).toHaveLength(16)
  expect(SHARD_KEYS[0]).toBe('log#0')
  expect(SHARD_KEYS[15]).toBe('log#f')
})

test('every generated id maps to a registered shard key', () => {
  // rand_b is random, so the last hex character is uniform over 0-f. If this
  // ever failed, get() would be looking in a partition that write() never
  // wrote to.
  for (let n = 0; n < 200; n += 1) {
    expect(SHARD_KEYS).toContain(shardKey(uuidv7()))
  }
})

test('shardKey uses the last hex character of the id', () => {
  expect(shardKey('01234567-89ab-7def-8000-00000000000a')).toBe('log#a')
  expect(shardKey('01234567-89ab-7def-8000-000000000003')).toBe('log#3')
})

test('an unfiltered page spans the whole key space', () => {
  expect(boundsFor({ limit: 50 })).toEqual({ lo: MIN_UUID, hi: MAX_UUID, exclude: [] })
})

test('from and to become sort-key bounds', () => {
  const from = new Date('2026-08-01T00:00:00Z')
  const to = new Date('2026-08-14T00:00:00Z')
  const bounds = boundsFor({ limit: 50, from, to })

  expect(bounds.lo).toBe(uuidv7Bound(from))
  expect(bounds.hi).toBe(uuidv7Bound(to))
  // BETWEEN is inclusive and Postgres uses `id < to`, so the upper bound is
  // excluded on the results instead.
  expect(bounds.exclude).toContain(uuidv7Bound(to))
})

test('after narrows the upper bound and is excluded', () => {
  const after = uuidv7()
  const bounds = boundsFor({ limit: 50, after })

  expect(bounds.hi).toBe(after)
  expect(bounds.lo).toBe(MIN_UUID)
  expect(bounds.exclude).toContain(after)
})

test('before narrows the lower bound and is excluded', () => {
  const before = uuidv7()
  const bounds = boundsFor({ limit: 50, before })

  expect(bounds.lo).toBe(before)
  expect(bounds.hi).toBe(MAX_UUID)
  expect(bounds.exclude).toContain(before)
})

test('a cursor inside a time range wins over the range bound', () => {
  // The narrower of the two is the correct bound: a cursor from page 3 must
  // not re-show page 2 just because the range starts earlier.
  const from = new Date('2026-08-01T00:00:00Z')
  const after = uuidv7(new Date('2026-08-10T00:00:00Z'))
  const bounds = boundsFor({ limit: 50, from, after })

  expect(bounds.lo).toBe(uuidv7Bound(from))
  expect(bounds.hi).toBe(after)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/dynamodb/keys.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/dynamodb/keys`

- [ ] **Step 3: Write the implementation**

Create `src/lib/logs/dynamodb/keys.ts`:

```typescript
import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'
import type { LogFilter } from '../types'

/**
 * Baked into the item keys forever.
 *
 * get() derives an item's partition from the last hex character of its id, so
 * changing this number leaves every existing item unreachable by detail
 * lookup — the list view would still show rows whose detail page 404s. It
 * must never become a setting or an environment variable.
 */
export const SHARDS = 16

export const SHARD_KEYS: readonly string[] = Array.from(
  { length: SHARDS },
  (_, n) => `log#${n.toString(16)}`,
)

/** The lowest and highest values a uuid string can take, so an absent range
 * bound needs no branch in the key condition. */
export const MIN_UUID = '00000000-0000-0000-0000-000000000000'
export const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

/** rand_b is random and untouched by the v7 layout, so the last hex
 * character distributes ids uniformly over the sixteen shards. */
export function shardKey(id: string): string {
  return `log#${id.slice(-1).toLowerCase()}`
}

export interface Bounds {
  lo: string
  hi: string
  /** Ids to drop from the merged results. DynamoDB allows exactly one sort-key
   * condition, so the only range operator available is BETWEEN — inclusive at
   * both ends. Postgres uses `id < to` and excludes the cursor row itself, so
   * the difference is closed here rather than with string-predecessor
   * arithmetic on uuids. */
  exclude: string[]
}

export function boundsFor(filter: LogFilter): Bounds {
  const lowerBounds = [filter.from ? uuidv7Bound(filter.from) : MIN_UUID]
  if (filter.before) lowerBounds.push(filter.before)

  const upperBounds = [filter.to ? uuidv7Bound(filter.to) : MAX_UUID]
  if (filter.after) upperBounds.push(filter.after)

  const exclude: string[] = []
  if (filter.after) exclude.push(filter.after)
  if (filter.before) exclude.push(filter.before)
  if (filter.to) exclude.push(uuidv7Bound(filter.to))

  return {
    // The narrowest bound wins: a cursor from a later page must not be
    // widened back out by the range it sits inside.
    lo: lowerBounds.reduce((a, b) => (a > b ? a : b)),
    hi: upperBounds.reduce((a, b) => (a < b ? a : b)),
    exclude,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/dynamodb/keys.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/dynamodb/keys.ts tests/lib/logs/dynamodb/keys.test.ts
git commit -m "feat(logs): add DynamoDB shard keys and query bounds"
```

---

### Task 4: Item mapping

Pure functions turning a `RequestLogEntry` into a DynamoDB item and back. No AWS, no container.

**Files:**
- Create: `src/lib/logs/dynamodb/item.ts`
- Test: `tests/lib/logs/dynamodb/item.test.ts`

**Interfaces:**
- Consumes: `shardKey` (Task 3), `monthStart`/`addMonths` (Task 1), `capPayload` from `../payload`
- Produces:
  - `DYNAMO_PAYLOAD_MAX_BYTES: number`, `ITEM_MAX_BYTES: number`
  - `LogItem` type — `Record<string, unknown> & { pk: string; sk: string }`
  - `expiresAtFor(writtenAt: Date, retentionMonths: number): number | null`
  - `toItem(entry: RequestLogEntry, settings: LoggingSettings, writtenAt?: Date): LogItem`
  - `toRow(item: Record<string, unknown>): LogRow`
  - `toDetail(item: Record<string, unknown>): LogDetail`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/dynamodb/item.test.ts`:

```typescript
import { expect, test } from 'vitest'
import {
  DYNAMO_PAYLOAD_MAX_BYTES, ITEM_MAX_BYTES, expiresAtFor, toDetail, toItem, toRow,
} from '@/lib/logs/dynamodb/item'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { RequestLogEntry } from '@/lib/logs/types'

const settings: LoggingSettings = {
  store: 'dynamodb', retentionMonths: 3, payloadMaxBytes: 262_144,
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('the item is keyed by shard and id', () => {
  const id = uuidv7()
  const item = toItem(entry({ id }), settings)

  expect(item.sk).toBe(id)
  expect(item.pk).toBe(`log#${id.slice(-1)}`)
})

test('null fields are omitted rather than stored', () => {
  // DynamoDB is schemaless, so an absent attribute costs no bytes and no
  // write units. A typical entry carries a dozen of these.
  const item = toItem(entry({ keyId: null }), settings)

  expect(item).not.toHaveProperty('apiKeyId')
  expect(item).not.toHaveProperty('errorType')
  expect(item).not.toHaveProperty('ttftMs')
  expect(item).not.toHaveProperty('pricing')
  expect(item).not.toHaveProperty('droppedParams')
  expect(item).not.toHaveProperty('attempts')
})

test('omitted attributes read back as null, not undefined', () => {
  // This is the invariant most likely to break: the UI types promise
  // `string | null`, and an undefined would render as a blank that no
  // consumer declared.
  const detail = toDetail(toItem(entry(), settings))

  expect(detail.errorType).toBeNull()
  expect(detail.ttftMs).toBeNull()
  expect(detail.pricing).toBeNull()
  expect(detail.droppedParams).toBeNull()
  expect(detail.attempts).toEqual([])
  expect(detail.payload).toBeNull()
})

test('costs are stored as strings so numeric precision survives', () => {
  // The Postgres columns are numeric(18, 9) and drizzle hands them back as
  // strings. A DynamoDB N would round them.
  const item = toItem(entry({
    cost: {
      inputUsd: '0.000123456', cachedUsd: null,
      outputUsd: '0.000000001', totalUsd: '0.000123457',
      pricing: { inputPerMtok: '3.000000', cachedInputPerMtok: null, outputPerMtok: '15.000000' },
    },
  }), settings)

  expect(item.costUsd).toBe('0.000123457')
  expect(item.outputCostUsd).toBe('0.000000001')
  expect(typeof item.costUsd).toBe('string')
  expect(toRow(item).costUsd).toBe('0.000123457')
})

test('an over-long model name is clamped to 128 characters', () => {
  const item = toItem(entry({ model: 'm'.repeat(500) }), settings)
  expect(String(item.model)).toHaveLength(128)
})

test('payloads round-trip through their JSON string form', () => {
  const item = toItem(entry({
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }), settings)

  // Stored as strings, not native maps: payloads are arbitrary user content,
  // and native storage would hit the 32-level nesting limit and round any
  // float past 38 digits.
  expect(typeof item.requestJson).toBe('string')

  const detail = toDetail(item)
  expect(detail.payload?.request).toEqual({ model: 'house-model' })
  expect(detail.payload?.response).toEqual({ ok: true })
  expect(detail.payload?.truncated).toBe(false)
  expect(detail.payloadCaptured).toBe(true)
})

test('the stored attributes decide whether a payload exists, not the flag', () => {
  const detail = toDetail({
    ...toItem(entry(), settings), payloadCaptured: true,
  })
  expect(detail.payload).toBeNull()
})

test('an oversized payload is capped to the driver limit', () => {
  const huge = { blob: 'x'.repeat(400 * 1024) }
  const item = toItem(entry({
    payload: { request: huge, response: huge, truncated: false },
  }), settings)

  expect(String(item.requestJson).length).toBeLessThanOrEqual(DYNAMO_PAYLOAD_MAX_BYTES + 1024)
  expect(item.payloadTruncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
})

test('pathological metadata still produces an item that fits', () => {
  // A ValidationException here would lose the whole log line, and logRequest
  // is deliberately not awaited — the loss would surface only on stderr. So
  // the item must fit by construction, not by luck.
  const attempts = Array.from({ length: 2000 }, (_, n) => ({
    n, targetId: 't'.repeat(200), provider: 'p'.repeat(200),
    model: 'm'.repeat(200), status: 503, latencyMs: 5, error: 'e'.repeat(200),
  }))
  const huge = { blob: 'x'.repeat(140 * 1024) }
  const item = toItem(entry({
    attempts, payload: { request: huge, response: huge, truncated: false },
  }), settings)

  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
  expect(JSON.parse(String(item.requestJson))).toEqual({
    truncated: true, error: 'too_large_for_store',
  })
})

test('the TTL mirrors the partition retention policy', () => {
  // dropExpiredPartitions drops month M when M < addMonths(now, -(n - 1)),
  // which is the same as: when now >= addMonths(M, n).
  const written = new Date('2026-08-14T16:13:00Z')
  expect(expiresAtFor(written, 3))
    .toBe(Math.floor(Date.UTC(2026, 10, 1) / 1000))
})

test('retention of zero means keep forever, so no TTL is stamped', () => {
  expect(expiresAtFor(new Date('2026-08-14T00:00:00Z'), 0)).toBeNull()

  const item = toItem(entry(), { ...settings, retentionMonths: 0 })
  expect(item).not.toHaveProperty('expiresAt')
})

test('createdAt is stamped at write time and reads back as a Date', () => {
  const writtenAt = new Date('2026-08-14T16:13:00Z')
  const row = toRow(toItem(entry(), settings, writtenAt))

  expect(row.createdAt).toBeInstanceOf(Date)
  expect(row.createdAt.toISOString()).toBe('2026-08-14T16:13:00.000Z')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/dynamodb/item.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/dynamodb/item`

- [ ] **Step 3: Write the implementation**

Create `src/lib/logs/dynamodb/item.ts`:

```typescript
import 'server-only'
import type { LoggingSettings } from '@/lib/settings'
import { addMonths, monthStart } from '../months'
import { capPayload } from '../payload'
import type {
  LogDetail, LoggedAttempt, LogRow, PricingSnapshot, RequestLogEntry, RequestOutcome,
} from '../types'
import { shardKey } from './keys'

/** Per side, and deliberately below the settings-level payloadMaxBytes: the
 * handler caps request and response independently, so a 256 KiB setting can
 * hand this store half a megabyte — past DynamoDB's 400 KB item limit. */
export const DYNAMO_PAYLOAD_MAX_BYTES = 150 * 1024

/** Headroom under the 400 KB hard limit for keys, metadata, and attribute
 * names. */
export const ITEM_MAX_BYTES = 380 * 1024

const MODEL_MAX_LENGTH = 128

export type LogItem = Record<string, unknown> & { pk: string; sk: string }

/** Matches postgres.ts so that `filter.model` equality behaves identically on
 * both drivers, even though DynamoDB has no column length to overflow. */
function clamp(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MODEL_MAX_LENGTH ? value.slice(0, MODEL_MAX_LENGTH) : value
}

/** Omits nullish instead of storing NULL. DynamoDB is schemaless, so an
 * absent attribute costs nothing at all — and the read mappers put the null
 * back. */
function put(item: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) item[key] = value
}

/**
 * The instant this entry should disappear, in epoch seconds.
 *
 * `dropExpiredPartitions` drops month M when `M < addMonths(now, -(n - 1))`,
 * which rearranges to: M drops when `now >= addMonths(M, n)`. Stamping that
 * makes retention behave identically on both drivers rather than
 * approximately.
 *
 * Zero keeps everything, mirroring `if (retentionMonths <= 0) return []`.
 */
export function expiresAtFor(writtenAt: Date, retentionMonths: number): number | null {
  if (retentionMonths <= 0) return null
  return Math.floor(addMonths(monthStart(writtenAt), retentionMonths).getTime() / 1000)
}

export function toItem(
  entry: RequestLogEntry,
  settings: LoggingSettings,
  writtenAt: Date = new Date(),
): LogItem {
  const item: Record<string, unknown> = {
    pk: shardKey(entry.id),
    // The id is stored once, as the sort key. A second copy would add ~40
    // bytes an item to duplicate something already there.
    sk: entry.id,
    createdAt: writtenAt.getTime(),
    stream: entry.stream,
    status: entry.status,
    outcome: entry.outcome,
    latencyMs: entry.latencyMs,
    payloadCaptured: entry.payload != null,
  }

  put(item, 'expiresAt', expiresAtFor(writtenAt, settings.retentionMonths))
  put(item, 'apiKeyId', entry.keyId)
  put(item, 'keyName', entry.keyName)
  put(item, 'model', clamp(entry.model))
  put(item, 'errorType', entry.errorType)
  put(item, 'errorCode', entry.errorCode)
  put(item, 'errorMessage', entry.errorMessage)
  put(item, 'ttftMs', entry.ttftMs)
  put(item, 'finalTargetId', entry.final?.targetId)
  put(item, 'finalProviderId', entry.final?.providerId)
  put(item, 'finalProvider', entry.final?.provider)
  put(item, 'finalUpstreamModel', clamp(entry.final?.upstreamModel))
  put(item, 'promptTokens', entry.usage?.promptTokens)
  put(item, 'completionTokens', entry.usage?.completionTokens)
  put(item, 'cachedTokens', entry.usage?.cachedTokens)
  put(item, 'reasoningTokens', entry.usage?.reasoningTokens)
  put(item, 'inputCostUsd', entry.cost?.inputUsd)
  put(item, 'cachedCostUsd', entry.cost?.cachedUsd)
  put(item, 'outputCostUsd', entry.cost?.outputUsd)
  put(item, 'costUsd', entry.cost?.totalUsd)
  put(item, 'pricing', entry.cost?.pricing)
  if (entry.attempts.length) item.attempts = entry.attempts
  if (entry.droppedParams?.length) item.droppedParams = entry.droppedParams

  if (entry.payload) {
    // Re-capping with the existing helper means an oversized body gets the
    // same truncation envelope the detail page already renders, rather than
    // a second shape the UI would have to learn.
    const request = capPayload(entry.payload.request, DYNAMO_PAYLOAD_MAX_BYTES)
    const response = capPayload(entry.payload.response, DYNAMO_PAYLOAD_MAX_BYTES)
    if (request.value !== null) item.requestJson = JSON.stringify(request.value)
    if (response.value !== null) item.responseJson = JSON.stringify(response.value)
    item.payloadTruncated = entry.payload.truncated || request.truncated || response.truncated
  }

  // Measured on the serialized record. JSON punctuation makes this a slight
  // over-estimate of DynamoDB's own accounting, which is the safe direction:
  // a ValidationException would lose the entire log line, and logRequest is
  // deliberately not awaited, so the loss would surface only on stderr.
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > ITEM_MAX_BYTES) {
    const envelope = JSON.stringify({ truncated: true, error: 'too_large_for_store' })
    if (item.requestJson !== undefined) item.requestJson = envelope
    if (item.responseJson !== undefined) item.responseJson = envelope
    item.payloadTruncated = true
  }

  return item as LogItem
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function toRow(item: Record<string, unknown>): LogRow {
  return {
    id: String(item.sk),
    createdAt: new Date(Number(item.createdAt)),
    keyName: str(item.keyName),
    model: str(item.model),
    stream: item.stream === true,
    status: Number(item.status),
    outcome: item.outcome as RequestOutcome,
    latencyMs: Number(item.latencyMs),
    ttftMs: num(item.ttftMs),
    finalProvider: str(item.finalProvider),
    finalUpstreamModel: str(item.finalUpstreamModel),
    promptTokens: num(item.promptTokens),
    completionTokens: num(item.completionTokens),
    costUsd: str(item.costUsd),
    payloadCaptured: item.payloadCaptured === true,
  }
}

export function toDetail(item: Record<string, unknown>): LogDetail {
  return {
    ...toRow(item),
    errorType: str(item.errorType),
    errorCode: str(item.errorCode),
    errorMessage: str(item.errorMessage),
    attempts: (item.attempts as LoggedAttempt[] | undefined) ?? [],
    finalTargetId: str(item.finalTargetId),
    cachedTokens: num(item.cachedTokens),
    reasoningTokens: num(item.reasoningTokens),
    inputCostUsd: str(item.inputCostUsd),
    cachedCostUsd: str(item.cachedCostUsd),
    outputCostUsd: str(item.outputCostUsd),
    pricing: (item.pricing as PricingSnapshot | undefined) ?? null,
    droppedParams: (item.droppedParams as string[] | undefined) ?? null,
    // The stored attributes are the fact; payloadCaptured is only a flag. An
    // item can carry the flag with nothing stored — written by an older
    // version, or edited by hand — and rendering a payload block for it would
    // claim a body that does not exist.
    payload: item.requestJson !== undefined || item.responseJson !== undefined
      ? {
          request: item.requestJson === undefined ? null : JSON.parse(String(item.requestJson)),
          response: item.responseJson === undefined ? null : JSON.parse(String(item.responseJson)),
          truncated: item.payloadTruncated === true,
        }
      : null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/dynamodb/item.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/dynamodb/item.ts tests/lib/logs/dynamodb/item.test.ts
git commit -m "feat(logs): map request log entries to DynamoDB items"
```

---

### Task 5: The shard merge

The riskiest algorithm in this plan, and the one most able to pass an integration test by luck. It is therefore written against an injected fetch function and tested with a fake that controls page boundaries exactly.

**Files:**
- Create: `src/lib/logs/dynamodb/merge.ts`
- Test: `tests/lib/logs/dynamodb/merge.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `MAX_ROUND_TRIPS: 8`, `MAX_ITEMS_EXAMINED: 10_000`
  - `ShardItem` — `{ sk: string }`
  - `ShardPage<T>` — `{ items: T[]; scanned: number; lastEvaluatedKey: Record<string, unknown> | undefined }`
  - `ShardFetch<T>` — `(shard: string, startKey: Record<string, unknown> | undefined) => Promise<ShardPage<T>>`
  - `collectPage<T>(opts): Promise<{ rows: T[]; hasMore: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/dynamodb/merge.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { MAX_ROUND_TRIPS, collectPage } from '@/lib/logs/dynamodb/merge'
import type { ShardFetch, ShardItem } from '@/lib/logs/dynamodb/merge'

/**
 * A fake shard source. `pages[shard]` is the list of pages that shard hands
 * back in order; the last one carries no continuation key.
 *
 * A fake rather than DynamoDB Local because the whole point of these tests is
 * to control where page boundaries fall. Against a real store the boundaries
 * are whatever the engine chooses, and a merge bug that only shows up on an
 * uneven split would pass every run.
 */
function fakeFetch(pages: Record<string, string[][]>): {
  fetch: ShardFetch<ShardItem>
  calls: () => number
} {
  const cursor: Record<string, number> = {}
  let calls = 0

  const fetch: ShardFetch<ShardItem> = async (shard) => {
    calls += 1
    const all = pages[shard] ?? []
    const n = cursor[shard] ?? 0
    cursor[shard] = n + 1
    const page = all[n] ?? []
    return {
      items: page.map((sk) => ({ sk })),
      scanned: page.length,
      lastEvaluatedKey: n + 1 < all.length ? { at: n } : undefined,
    }
  }

  return { fetch, calls: () => calls }
}

const SHARDS = ['log#0', 'log#1']

test('merges shards into one descending run', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['f', 'd', 'b']],
    'log#1': [['e', 'c', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 6, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['f', 'e', 'd', 'c', 'b', 'a'])
  expect(out.hasMore).toBe(false)
})

test('merges ascending when paging backwards', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['a', 'c', 'e']],
    'log#1': [['b', 'd', 'f']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 6, descending: false, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
})

test('never emits a row a lagging shard could still outrank', async () => {
  // The frontier invariant. log#1 holds the global best but returns it on a
  // later page. An implementation that emitted log#0's buffer greedily would
  // return d,c,b — losing z entirely and corrupting the cursor.
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c', 'b']],
    'log#1': [[], ['z', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 3, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['z', 'd', 'c'])
  expect(out.hasMore).toBe(true)
})

test('keeps fetching a shard whose page was filtered empty', async () => {
  // A FilterExpression is applied after Limit, so DynamoDB routinely returns
  // an empty page with a continuation key. Treating that as exhausted would
  // silently drop everything behind it.
  const { fetch } = fakeFetch({
    'log#0': [[], [], ['c', 'a']],
    'log#1': [['b']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 5, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['c', 'b', 'a'])
  expect(out.hasMore).toBe(false)
})

test('excluded ids are dropped from the merge', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c']],
    'log#1': [['b', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 5, descending: true, exclude: ['c', 'a'],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['d', 'b'])
})

test('hasMore is set by the extra row, which is not returned', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c']],
    'log#1': [['b', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 2, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['d', 'c'])
  expect(out.hasMore).toBe(true)
})

test('a spent round-trip budget ends the page rather than looping', async () => {
  // An endlessly-filtering shard must not spin. The page comes back short
  // with hasMore set, so paging still works — the documented difference from
  // the Postgres store.
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch, calls } = fakeFetch({ 'log#0': empty, 'log#1': empty })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(calls()).toBeLessThanOrEqual(MAX_ROUND_TRIPS * SHARDS.length)
})

test('an empty store yields an empty page with no more', async () => {
  const { fetch } = fakeFetch({})

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/dynamodb/merge.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/dynamodb/merge`

- [ ] **Step 3: Write the implementation**

Create `src/lib/logs/dynamodb/merge.ts`:

```typescript
import 'server-only'

/** Bounds what one page of the log viewer can cost. A FilterExpression is
 * applied after Limit, so a narrow filter over a wide range can read a great
 * deal and match almost nothing. */
export const MAX_ROUND_TRIPS = 8
export const MAX_ITEMS_EXAMINED = 10_000

export interface ShardItem {
  sk: string
}

export interface ShardPage<T extends ShardItem> {
  items: T[]
  /** What DynamoDB read, not what it returned — the two differ under a
   * FilterExpression, and the budget cares about the former. */
  scanned: number
  lastEvaluatedKey: Record<string, unknown> | undefined
}

export type ShardFetch<T extends ShardItem> = (
  shard: string,
  startKey: Record<string, unknown> | undefined,
) => Promise<ShardPage<T>>

export interface CollectOptions<T extends ShardItem> {
  fetch: ShardFetch<T>
  shards: readonly string[]
  limit: number
  descending: boolean
  exclude: readonly string[]
}

export interface Collected<T> {
  rows: T[]
  hasMore: boolean
}

/**
 * Merges the shards into one globally ordered page.
 *
 * The invariant that makes this correct: a row may be emitted only when every
 * shard that could still contribute has a buffered head. Each shard's query
 * returns sorted items, so a buffered head is that shard's best remaining
 * candidate — but a shard with an empty buffer and a continuation key could
 * hold something better, and must be fetched before anything is emitted.
 *
 * That invariant is also what lets the caller use a small per-shard Limit.
 * Without it, correctness would require requesting limit + 1 from every shard
 * and reading roughly `shards.length` times the data actually displayed;
 * with it, under-supply is merely another round trip.
 */
export async function collectPage<T extends ShardItem>(
  opts: CollectOptions<T>,
): Promise<Collected<T>> {
  const excluded = new Set(opts.exclude)
  const state = opts.shards.map((shard) => ({
    shard,
    buffer: [] as T[],
    startKey: undefined as Record<string, unknown> | undefined,
    exhausted: false,
  }))

  // One extra row is what distinguishes "this is the last page" from "there
  // is another", without a count query.
  const want = opts.limit + 1
  const matched: T[] = []
  let roundTrips = 0
  let examined = 0
  let budgetSpent = false

  while (matched.length < want) {
    const hungry = state.filter((s) => s.buffer.length === 0 && !s.exhausted)

    if (hungry.length > 0) {
      if (roundTrips >= MAX_ROUND_TRIPS || examined >= MAX_ITEMS_EXAMINED) {
        budgetSpent = true
        break
      }
      roundTrips += 1
      await Promise.all(hungry.map(async (s) => {
        const page = await opts.fetch(s.shard, s.startKey)
        examined += page.scanned
        s.buffer = page.items.filter((item) => !excluded.has(item.sk))
        s.startKey = page.lastEvaluatedKey
        // An empty page with a continuation key is normal under a filter and
        // must not be read as the end of the shard.
        s.exhausted = page.lastEvaluatedKey === undefined
      }))
      continue
    }

    const ready = state.filter((s) => s.buffer.length > 0)
    if (ready.length === 0) break

    let best = ready[0]
    for (const s of ready) {
      const better = opts.descending
        ? s.buffer[0].sk > best.buffer[0].sk
        : s.buffer[0].sk < best.buffer[0].sk
      if (better) best = s
    }
    matched.push(best.buffer.shift() as T)
  }

  return {
    rows: matched.slice(0, opts.limit),
    // A spent budget is reported as "more available" rather than as the end
    // of the data: the page is short, but its cursor still leads somewhere.
    hasMore: matched.length > opts.limit || budgetSpent,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/dynamodb/merge.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/dynamodb/merge.ts tests/lib/logs/dynamodb/merge.test.ts
git commit -m "feat(logs): merge sharded DynamoDB queries into one ordered page"
```

---

### Task 6: DynamoDB Local test infrastructure

Independent of Tasks 1–5; may be built in parallel.

**Files:**
- Modify: `docker-compose.test.yml`
- Modify: `.env.test.example`
- Create: `tests/helpers/dynamo.ts`
- Test: `tests/helpers/dynamo.test.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `testDynamoConfig(): { table: string; endpoint: string; region: string } | null` — null when the env is not set, which is how tests skip
  - `createLogsTable(): Promise<void>` — idempotent, retries while the container boots
  - `resetLogsTable(): Promise<void>` — delete and recreate, the DynamoDB equivalent of `resetDb()`

- [ ] **Step 1: Install the AWS SDK**

```bash
pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

- [ ] **Step 2: Add DynamoDB Local to the test stack**

In `docker-compose.test.yml`, add a third service after `redis-test`:

```yaml
  dynamodb-test:
    image: amazon/dynamodb-local:2.5.2
    # Nothing here is worth resurrecting; it dies with the container.
    restart: "no"
    # 8001, not 8000: the same courtesy the test Postgres pays 5432 and the
    # test Redis pays 6379.
    ports:
      - "8001:8000"
    # -inMemory is this service's tmpfs: no file is written, so the data
    # cannot outlive the container or accumulate across runs.
    command: ["-jar", "DynamoDBLocal.jar", "-inMemory", "-port", "8000"]
```

Note the deliberate absence of a healthcheck — the image ships no `curl` or `wget`, and `compose --wait` treats a service without one as ready once it is running. The readiness gap is closed in `createLogsTable()`, which retries. If a later change adds a healthcheck, `bash`'s `/dev/tcp` is the probe that needs no extra binary.

- [ ] **Step 3: Add the test environment variables**

Append to `.env.test.example`:

```bash
# The disposable DynamoDB Local from docker-compose.test.yml.
#
# Deliberately NOT named DYNAMODB_LOGS_TABLE: that variable is what registers
# the dynamodb driver in DRIVERS, so setting it here would add the driver to
# every test's registry — including runLogMaintenance, which maintains every
# registered driver and would then call AWS on tests that have nothing to do
# with DynamoDB. Only the DynamoDB store tests read these, and they skip
# without them. Same reasoning as TEST_REDIS_URL above.
TEST_DYNAMODB_TABLE=babellm_request_logs_test
TEST_DYNAMODB_ENDPOINT=http://localhost:8001

# DynamoDB Local rejects a request carrying no credentials at all, but never
# validates them. Public on purpose, like the three values above.
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
```

Then refresh your own copy: `cp .env.test.example .env.test`

- [ ] **Step 4: Write the failing test**

Create `tests/helpers/dynamo.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { DescribeTimeToLiveCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createLogsTable, resetLogsTable, testDynamoConfig } from './dynamo'

const config = testDynamoConfig()
const when = config ? test : test.skip

when('the helper provisions a table with TTL enabled on expiresAt', async () => {
  await createLogsTable()

  const client = new DynamoDBClient({
    region: config!.region,
    endpoint: config!.endpoint,
  })
  const out = await client.send(new DescribeTimeToLiveCommand({ TableName: config!.table }))

  expect(out.TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED')
  expect(out.TimeToLiveDescription?.AttributeName).toBe('expiresAt')
})

when('createLogsTable is idempotent', async () => {
  await createLogsTable()
  await expect(createLogsTable()).resolves.toBeUndefined()
})

when('resetLogsTable leaves an empty table behind', async () => {
  await expect(resetLogsTable()).resolves.toBeUndefined()
})
```

- [ ] **Step 5: Run test to verify it fails**

```bash
pnpm test:db:up
pnpm vitest run tests/helpers/dynamo.test.ts
```

Expected: FAIL — cannot resolve `./dynamo`

- [ ] **Step 6: Write the helper**

Create `tests/helpers/dynamo.ts`:

```typescript
import {
  CreateTableCommand, DeleteTableCommand, DynamoDBClient,
  ResourceInUseException, ResourceNotFoundException,
  UpdateTimeToLiveCommand, waitUntilTableExists, waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb'

/**
 * The disposable DynamoDB Local, or null when it is not configured.
 *
 * Reads TEST_DYNAMODB_*, never DYNAMODB_LOGS_TABLE: the latter registers the
 * driver for the whole suite. A null return is how the DynamoDB tests skip on
 * a checkout that has not started the container.
 */
export function testDynamoConfig(): { table: string; endpoint: string; region: string } | null {
  const table = process.env.TEST_DYNAMODB_TABLE
  const endpoint = process.env.TEST_DYNAMODB_ENDPOINT
  if (!table || !endpoint) return null
  return { table, endpoint, region: process.env.AWS_REGION ?? 'us-east-1' }
}

function client(): DynamoDBClient {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  return new DynamoDBClient({ region: config.region, endpoint: config.endpoint })
}

/**
 * Creates the table the production driver expects, with TTL enabled.
 *
 * Idempotent, and it retries while the container finishes booting: the
 * compose service carries no healthcheck (the image has no curl or wget), so
 * this is where readiness is actually established.
 */
export async function createLogsTable(): Promise<void> {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  const db = client()

  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.send(new CreateTableCommand({
        TableName: config.table,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }))
      break
    } catch (err) {
      if (err instanceof ResourceInUseException) return
      // Connection refused while the JVM starts. Ten attempts at 300ms is
      // comfortably longer than DynamoDB Local takes to accept a socket.
      if (attempt >= 10) throw err
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  await waitUntilTableExists({ client: db, maxWaitTime: 30 }, { TableName: config.table })
  await db.send(new UpdateTimeToLiveCommand({
    TableName: config.table,
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  }))
}

/**
 * The DynamoDB counterpart of resetDb(): a known-empty slate between tests.
 *
 * Drop and recreate rather than scan and delete. On an in-memory local
 * instance that is both faster and unconditional — a scan-and-delete leaves
 * behind anything written while it ran.
 */
export async function resetLogsTable(): Promise<void> {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  const db = client()

  try {
    await db.send(new DeleteTableCommand({ TableName: config.table }))
    await waitUntilTableNotExists({ client: db, maxWaitTime: 30 }, { TableName: config.table })
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err
  }

  await createLogsTable()
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run tests/helpers/dynamo.test.ts`
Expected: PASS — 3 tests

If the container is still booting, `createLogsTable` retries; if it fails after ten attempts, check `docker compose -f docker-compose.test.yml logs dynamodb-test`.

- [ ] **Step 8: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add docker-compose.test.yml .env.test.example tests/helpers/dynamo.ts tests/helpers/dynamo.test.ts package.json pnpm-lock.yaml
git commit -m "test(logs): add disposable DynamoDB Local to the test stack"
```

---

### Task 7: The driver

**Files:**
- Create: `src/lib/logs/dynamodb/index.ts`
- Test: `tests/lib/logs/dynamodb/store.test.ts`

**Interfaces:**
- Consumes: `SHARD_KEYS`, `SHARDS`, `boundsFor`, `shardKey` (Task 3); `LogItem`, `toDetail`, `toItem`, `toRow` (Task 4); `collectPage` (Task 5)
- Produces:
  - `DynamoStoreConfig` — `{ table: string; endpoint?: string; region?: string }`
  - `createDynamoStore(config: DynamoStoreConfig): ReadableRequestLogStore`
  - `dynamodbStore: ReadableRequestLogStore | null` — non-null only when `DYNAMODB_LOGS_TABLE` is set

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/dynamodb/store.test.ts`:

```typescript
import { beforeEach, expect, test } from 'vitest'
import { createDynamoStore } from '@/lib/logs/dynamodb'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { ReadableRequestLogStore, RequestLogEntry } from '@/lib/logs/types'
import { createLogsTable, resetLogsTable, testDynamoConfig } from '../../../helpers/dynamo'

const config = testDynamoConfig()
const when = config ? test : test.skip

const settings: LoggingSettings = {
  store: 'dynamodb', retentionMonths: 3, payloadMaxBytes: 262_144,
}

let store: ReadableRequestLogStore

beforeEach(async () => {
  if (!config) return
  await resetLogsTable()
  store = createDynamoStore({ table: config.table, endpoint: config.endpoint, region: config.region })
})

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

when('a written entry comes back from get under every shard', async () => {
  // Sixteen entries is not sixteen shards, so this writes until each shard
  // key has been exercised at least once. A get() that looked in the wrong
  // partition would fail here and nowhere else.
  const ids = Array.from({ length: 200 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  for (const id of ids) {
    expect((await store.get(id))?.id).toBe(id)
  }
})

when('query returns rows newest first across shards', async () => {
  const ids = Array.from({ length: 40 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  const page = await store.query({ limit: 40 })
  expect(page.rows.map((r) => r.id)).toEqual([...ids].reverse())
})

when('paging forwards and back returns the same rows', async () => {
  const ids = Array.from({ length: 30 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  const first = await store.query({ limit: 10 })
  expect(first.rows).toHaveLength(10)
  expect(first.nextCursor).not.toBeNull()
  expect(first.prevCursor).toBeNull()

  const second = await store.query({ limit: 10, after: first.nextCursor! })
  expect(second.rows).toHaveLength(10)
  expect(second.rows[0].id).not.toBe(first.rows[9].id)

  const back = await store.query({ limit: 10, before: second.prevCursor! })
  expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
})

when('filters narrow the page', async () => {
  await store.write(entry({ model: 'alpha', status: 200 }), settings)
  await store.write(entry({ model: 'beta', status: 500, outcome: 'error' }), settings)
  await store.write(entry({ model: 'alpha', status: 404 }), settings)

  expect((await store.query({ limit: 10, model: 'alpha' })).rows).toHaveLength(2)
  expect((await store.query({ limit: 10, statusClass: 'success' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, statusClass: 'client_error' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, statusClass: 'server_error' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(1)
})

when('a time range selects on the id, which is the clock', async () => {
  const old = uuidv7(new Date('2026-01-01T00:00:00Z'))
  const recent = uuidv7(new Date('2026-08-14T00:00:00Z'))
  await store.write(entry({ id: old }), settings)
  await store.write(entry({ id: recent }), settings)

  const page = await store.query({ limit: 10, from: new Date('2026-06-01T00:00:00Z') })
  expect(page.rows.map((r) => r.id)).toEqual([recent])
})

when('get returns null rather than throwing for a malformed id', async () => {
  // A hand-edited URL reaches this with anything at all, and a shard key
  // derived from garbage would query a partition that cannot exist.
  expect(await store.get('not-a-uuid')).toBeNull()
  expect(await store.get('')).toBeNull()
  expect(await store.get("'; DROP TABLE request_logs; --")).toBeNull()
})

when('maintain reports no partitions and does not throw', async () => {
  expect(await store.maintain(new Date(), settings)).toEqual({ created: [], dropped: [] })
})

when('a missing table produces an error naming it', async () => {
  const missing = createDynamoStore({
    table: 'no_such_table', endpoint: config!.endpoint, region: config!.region,
  })
  await expect(missing.query({ limit: 10 })).rejects.toThrow(/no_such_table/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/dynamodb/store.test.ts`
Expected: FAIL — cannot resolve `@/lib/logs/dynamodb`

- [ ] **Step 3: Write the driver**

Create `src/lib/logs/dynamodb/index.ts`:

```typescript
import 'server-only'
import {
  DescribeTimeToLiveCommand, DynamoDBClient, ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { LoggingSettings } from '@/lib/settings'
import type {
  LogDetail, LogFilter, LogPage, MaintenanceResult, ReadableRequestLogStore, RequestLogEntry,
} from '../types'
import { type LogItem, toDetail, toItem, toRow } from './item'
import { SHARDS, SHARD_KEYS, boundsFor, shardKey } from './keys'
import { collectPage } from './merge'

/** Cursors and detail ids arrive from a URL. A non-uuid would produce a shard
 * key for a partition that cannot exist, so it is rejected here and read as
 * "no such row" — the same contract the Postgres driver keeps. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Everything the list view renders. Projecting these keeps the payload
 * attributes off the wire, which cuts latency — though not cost: DynamoDB
 * bills a Query on the item size read from storage, before projection. */
const LIST_ATTRIBUTES = [
  'sk', 'createdAt', 'keyName', 'model', 'stream', 'status', 'outcome', 'latencyMs',
  'ttftMs', 'finalProvider', 'finalUpstreamModel', 'promptTokens', 'completionTokens',
  'costUsd', 'payloadCaptured',
]

// Aliasing every projected attribute sidesteps DynamoDB's reserved words
// wholesale — `status` is one of them — instead of maintaining a list of
// which names happen to need it.
const PROJECTION = LIST_ATTRIBUTES.map((_, n) => `#p${n}`).join(', ')
const PROJECTION_NAMES = Object.fromEntries(
  LIST_ATTRIBUTES.map((name, n) => [`#p${n}`, name]),
)

export interface DynamoStoreConfig {
  table: string
  endpoint?: string
  region?: string
}

interface Filters {
  expression: string | undefined
  names: Record<string, string>
  values: Record<string, unknown>
}

function filtersFor(filter: LogFilter): Filters {
  const clauses: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  const equals = (attribute: string, value: string) => {
    names[`#f_${attribute}`] = attribute
    values[`:f_${attribute}`] = value
    clauses.push(`#f_${attribute} = :f_${attribute}`)
  }

  if (filter.apiKeyId) equals('apiKeyId', filter.apiKeyId)
  if (filter.model) equals('model', filter.model)
  if (filter.outcome) equals('outcome', filter.outcome)

  if (filter.statusClass) {
    names['#f_status'] = 'status'
    if (filter.statusClass === 'success') {
      values[':s400'] = 400
      clauses.push('#f_status < :s400')
    } else if (filter.statusClass === 'client_error') {
      values[':s400'] = 400
      values[':s499'] = 499
      clauses.push('#f_status BETWEEN :s400 AND :s499')
    } else {
      values[':s500'] = 500
      clauses.push('#f_status >= :s500')
    }
  }

  return { expression: clauses.length ? clauses.join(' AND ') : undefined, names, values }
}

/** The raw AWS error names no table, and a misconfigured DYNAMODB_LOGS_TABLE
 * is the likeliest failure here — the operator provisions the table, not the
 * gateway. */
function describe(table: string, err: unknown): unknown {
  if (err instanceof ResourceNotFoundException) {
    return new Error(
      `DynamoDB table "${table}" does not exist. Check DYNAMODB_LOGS_TABLE and the region.`,
      { cause: err },
    )
  }
  return err
}

export function createDynamoStore(config: DynamoStoreConfig): ReadableRequestLogStore {
  const raw = new DynamoDBClient({
    ...(config.region ? { region: config.region } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  })
  // removeUndefinedValues because the item mapper omits nullish attributes by
  // leaving them off entirely; without it the client rejects the write.
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  })
  const { table } = config

  return {
    name: 'dynamodb',
    readable: true,

    async write(entry: RequestLogEntry, settings: LoggingSettings): Promise<void> {
      try {
        await doc.send(new PutCommand({ TableName: table, Item: toItem(entry, settings) }))
      } catch (err) {
        throw describe(table, err)
      }
    },

    async query(filter: LogFilter): Promise<LogPage> {
      const { lo, hi, exclude } = boundsFor(filter)
      // `before` walks toward newer rows, so it queries ascending and the
      // page is reversed at the end — the same branch as postgres.ts.
      const descending = !filter.before
      const filters = filtersFor(filter)
      // The merge's frontier invariant makes a small per-shard limit safe:
      // under-supply costs another round trip rather than a wrong answer.
      const perShard = Math.ceil((filter.limit + 1) / SHARDS) + 4

      const collected = await collectPage<LogItem>({
        shards: SHARD_KEYS,
        limit: filter.limit,
        descending,
        exclude,
        fetch: async (shard, startKey) => {
          try {
            const out = await doc.send(new QueryCommand({
              TableName: table,
              KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
              ExpressionAttributeNames: {
                '#pk': 'pk', '#sk': 'sk', ...PROJECTION_NAMES, ...filters.names,
              },
              ExpressionAttributeValues: {
                ':pk': shard, ':lo': lo, ':hi': hi, ...filters.values,
              },
              ...(filters.expression ? { FilterExpression: filters.expression } : {}),
              ProjectionExpression: PROJECTION,
              ScanIndexForward: !descending,
              Limit: perShard,
              ExclusiveStartKey: startKey,
            }))
            return {
              items: (out.Items ?? []) as LogItem[],
              scanned: out.ScannedCount ?? 0,
              lastEvaluatedKey: out.LastEvaluatedKey,
            }
          } catch (err) {
            throw describe(table, err)
          }
        },
      })

      const rows = collected.rows.map(toRow)
      const ordered = filter.before ? rows.reverse() : rows

      return {
        rows: ordered,
        nextCursor: ordered.length && (filter.before || collected.hasMore)
          ? ordered[ordered.length - 1].id
          : null,
        // On an `after` page, newer rows are guaranteed by the cursor having
        // come from a row up there. On a `before` page only hasMore knows.
        prevCursor: ordered.length && (filter.after || (filter.before && collected.hasMore))
          ? ordered[0].id
          : null,
      }
    },

    async get(id: string): Promise<LogDetail | null> {
      if (!UUID_RE.test(id)) return null
      try {
        const out = await doc.send(new GetCommand({
          TableName: table,
          Key: { pk: shardKey(id), sk: id },
        }))
        return out.Item ? toDetail(out.Item) : null
      } catch (err) {
        throw describe(table, err)
      }
    },

    /**
     * There is nothing to provision or drop: TTL is stamped on each item at
     * write time, and DynamoDB does the discarding.
     *
     * The one thing worth doing daily is checking that TTL is actually
     * enabled. The operator provisions this table, so a forgotten TTL is both
     * unbounded growth and a retention-policy violation on captured prompt
     * content — silent in every other way.
     */
    async maintain(): Promise<MaintenanceResult> {
      try {
        const out = await raw.send(new DescribeTimeToLiveCommand({ TableName: table }))
        const ttl = out.TimeToLiveDescription
        if (ttl?.TimeToLiveStatus !== 'ENABLED' || ttl?.AttributeName !== 'expiresAt') {
          console.error(
            `[gateway] DynamoDB table "${table}" has no TTL enabled on expiresAt; request logs will never expire`,
          )
        }
      } catch (err) {
        console.error(`[gateway] could not check TTL on DynamoDB table "${table}"`, err)
      }
      return { created: [], dropped: [] }
    },
  }
}

/**
 * The configured driver, or null.
 *
 * DYNAMODB_LOGS_TABLE doubles as the enable switch. A null here keeps the
 * driver out of DRIVERS entirely, which is what makes an unconfigured
 * gateway's DynamoDB support genuinely inert: the Settings picker does not
 * offer it, and runLogMaintenance never calls it.
 */
export const dynamodbStore: ReadableRequestLogStore | null = process.env.DYNAMODB_LOGS_TABLE
  ? createDynamoStore({
      table: process.env.DYNAMODB_LOGS_TABLE,
      ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
      ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
    })
  : null
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/logs/dynamodb/store.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/logs/dynamodb/index.ts tests/lib/logs/dynamodb/store.test.ts
git commit -m "feat(logs): add the DynamoDB request log driver"
```

---

### Task 8: A contract suite both drivers run

The point of a driver union is that drivers are interchangeable. Nothing tests that today — `postgres-store.test.ts` tests Postgres. Extracting the driver-agnostic assertions is what turns "we wrote two stores" into "the two stores agree".

**Files:**
- Create: `tests/lib/logs/store-contract.ts`
- Modify: `tests/lib/logs/postgres-store.test.ts` (invoke the suite)
- Modify: `tests/lib/logs/dynamodb/store.test.ts` (invoke the suite)

**Interfaces:**
- Consumes: `ReadableRequestLogStore`
- Produces: `storeContract(name: string, store: () => ReadableRequestLogStore): void` — the caller's existing top-level `beforeEach` supplies the reset

- [ ] **Step 1: Write the contract suite**

Create `tests/lib/logs/store-contract.ts`:

```typescript
import { describe, expect, test } from 'vitest'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { ReadableRequestLogStore, RequestLogEntry } from '@/lib/logs/types'

const settings: LoggingSettings = {
  store: 'contract', retentionMonths: 3, payloadMaxBytes: 262_144,
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

/**
 * What every readable store must do identically.
 *
 * RequestLogStore is a union precisely so drivers can be swapped, and a
 * driver-specific test file cannot check that claim. Anything asserted here
 * is behaviour the admin UI relies on regardless of which store is
 * configured; anything genuinely driver-specific belongs in that driver's own
 * file.
 *
 * Resetting is the caller's job, not this suite's. Both driver test files
 * already carry a top-level `beforeEach` that resets their store, and a
 * top-level hook applies to nested describes too — so owning reset here would
 * run it twice per test. That is merely wasteful for a Postgres TRUNCATE and
 * genuinely slow for a DynamoDB table drop-and-recreate.
 */
export function storeContract(
  name: string,
  store: () => ReadableRequestLogStore,
): void {
  describe(`${name} store contract`, () => {
    test('a written entry comes back from query under the id it was given', async () => {
      const id = uuidv7()
      await store().write(entry({ id, model: 'house-model' }), settings)

      const page = await store().query({ limit: 10 })
      expect(page.rows).toHaveLength(1)
      expect(page.rows[0]).toMatchObject({ id, model: 'house-model', status: 200 })
    })

    test('get returns the attempt chain and the payload', async () => {
      const id = uuidv7()
      await store().write(entry({
        id,
        attempts: [
          { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
          { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
        ],
        payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
      }), settings)

      const detail = await store().get(id)
      expect(detail?.attempts).toHaveLength(2)
      expect(detail?.attempts[0].error).toBe('down')
      expect(detail?.payloadCaptured).toBe(true)
      expect(detail?.payload?.request).toEqual({ model: 'house-model' })
      expect(detail?.payload?.truncated).toBe(false)
    })

    test('get returns null for an unknown id', async () => {
      expect(await store().get(uuidv7())).toBeNull()
    })

    test('get returns null rather than throwing for a malformed id', async () => {
      expect(await store().get('not-a-uuid')).toBeNull()
      expect(await store().get('')).toBeNull()
      expect(await store().get("'; DROP TABLE request_logs; --")).toBeNull()
    })

    test('absent optional fields read back as null, never undefined', async () => {
      const id = uuidv7()
      await store().write(entry({ id }), settings)

      const detail = await store().get(id)
      expect(detail?.errorType).toBeNull()
      expect(detail?.ttftMs).toBeNull()
      expect(detail?.pricing).toBeNull()
      expect(detail?.droppedParams).toBeNull()
      expect(detail?.payload).toBeNull()
      expect(detail?.attempts).toEqual([])
    })

    test('rows come back newest first', async () => {
      const ids = Array.from({ length: 5 }, () => uuidv7())
      for (const id of ids) await store().write(entry({ id }), settings)

      const page = await store().query({ limit: 10 })
      expect(page.rows.map((r) => r.id)).toEqual([...ids].reverse())
    })

    test('a full page offers a next cursor and no previous one', async () => {
      for (let n = 0; n < 5; n += 1) await store().write(entry(), settings)

      const page = await store().query({ limit: 3 })
      expect(page.rows).toHaveLength(3)
      expect(page.nextCursor).toBe(page.rows[2].id)
      expect(page.prevCursor).toBeNull()
    })

    test('paging forward then back lands on the original rows', async () => {
      for (let n = 0; n < 9; n += 1) await store().write(entry(), settings)

      const first = await store().query({ limit: 3 })
      const second = await store().query({ limit: 3, after: first.nextCursor! })
      const back = await store().query({ limit: 3, before: second.prevCursor! })

      expect(second.rows.map((r) => r.id)).not.toEqual(first.rows.map((r) => r.id))
      expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
    })

    test('the last page reports no next cursor', async () => {
      for (let n = 0; n < 3; n += 1) await store().write(entry(), settings)

      const page = await store().query({ limit: 10 })
      expect(page.nextCursor).toBeNull()
    })

    test('filters narrow the page the same way on every store', async () => {
      await store().write(entry({ model: 'alpha', status: 200 }), settings)
      await store().write(entry({ model: 'beta', status: 500, outcome: 'error' }), settings)
      await store().write(entry({ model: 'alpha', status: 404 }), settings)

      expect((await store().query({ limit: 10, model: 'alpha' })).rows).toHaveLength(2)
      expect((await store().query({ limit: 10, statusClass: 'success' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, statusClass: 'client_error' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, statusClass: 'server_error' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, outcome: 'error' })).rows).toHaveLength(1)
    })

    test('a time range selects on the id, which carries the clock', async () => {
      const old = uuidv7(new Date('2026-01-01T00:00:00Z'))
      const recent = uuidv7(new Date('2026-08-14T00:00:00Z'))
      await store().write(entry({ id: old }), settings)
      await store().write(entry({ id: recent }), settings)

      const page = await store().query({ limit: 10, from: new Date('2026-06-01T00:00:00Z') })
      expect(page.rows.map((r) => r.id)).toEqual([recent])
    })

    test('an empty store returns an empty page with no cursors', async () => {
      const page = await store().query({ limit: 10 })
      expect(page.rows).toEqual([])
      expect(page.nextCursor).toBeNull()
      expect(page.prevCursor).toBeNull()
    })
  })
}
```

- [ ] **Step 2: Run the suite against Postgres**

Add to `tests/lib/logs/postgres-store.test.ts`, after the existing imports and
below the existing `beforeEach(resetDb)` on line 9:

```typescript
import { storeContract } from './store-contract'

storeContract('postgres', () => postgresStore)
```

The file's top-level `beforeEach(resetDb)` already applies to the contract's
nested `describe`, so the suite gets a clean database without resetting twice.

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: PASS. If any contract test fails against Postgres, that is a real disagreement between the drivers — resolve it before continuing rather than weakening the assertion.

- [ ] **Step 3: Run the suite against DynamoDB**

Add to `tests/lib/logs/dynamodb/store.test.ts`, after the existing `beforeEach`:

```typescript
import { storeContract } from '../store-contract'

// Guarded, not skipped: without the container there is no `store` for the
// suite to call at all. The driver-specific tests above use test.skip for the
// same reason.
if (config) storeContract('dynamodb', () => store)
```

The file's top-level `beforeEach` already calls `resetLogsTable()` and rebuilds
`store`, and it applies to the contract's nested `describe` — so a table
drop-and-recreate happens once per contract test, not twice.

Run: `pnpm vitest run tests/lib/logs/dynamodb/store.test.ts`
Expected: PASS — the driver-specific tests plus 13 contract tests.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, 0 failures.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm typecheck && pnpm lint
git add tests/lib/logs/store-contract.ts tests/lib/logs/postgres-store.test.ts tests/lib/logs/dynamodb/store.test.ts
git commit -m "test(logs): run both stores through one contract suite"
```

---

### Task 9: Registration, settings copy, and documentation

**Files:**
- Modify: `src/lib/logs/registry.ts` (conditional registration)
- Modify: `src/app/(admin)/settings/governance-form.tsx` (one line of copy)
- Modify: `README.md`
- Test: `tests/lib/logs/dynamodb/registration.test.ts`

**Interfaces:**
- Consumes: `dynamodbStore` (Task 7)
- Produces: `DRIVERS.dynamodb`, present only when `DYNAMODB_LOGS_TABLE` is set

- [ ] **Step 1: Write the failing test**

Create `tests/lib/logs/dynamodb/registration.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { DRIVERS } from '@/lib/logs'

test('the driver stays out of the registry when it is not configured', () => {
  // DYNAMODB_LOGS_TABLE is the enable switch, and .env.test deliberately does
  // not set it. An unconfigured driver in DRIVERS would show up in the
  // Settings picker and, worse, be called by runLogMaintenance — which
  // maintains every registered driver, not only the active one.
  expect(process.env.DYNAMODB_LOGS_TABLE).toBeUndefined()
  expect(Object.hasOwn(DRIVERS, 'dynamodb')).toBe(false)
})

test('postgres is always registered', () => {
  expect(DRIVERS.postgres?.name).toBe('postgres')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/logs/dynamodb/registration.test.ts`
Expected: PASS — 2 tests.

This one is a regression guard rather than a red-green test: it passes before the change too, because nothing registers `dynamodb` yet. Its value is in Step 4, where it must **still** pass once registration exists. If it goes red there, the driver is leaking into the suite's registry and every maintenance test is now making AWS calls.

- [ ] **Step 3: Register the driver conditionally**

In `src/lib/logs/registry.ts`, add the import:

```typescript
import { dynamodbStore } from './dynamodb'
```

and replace the `DRIVERS` declaration:

```typescript
/** Every driver the gateway ships. Adding one is a fork's single entry here
 * plus a module implementing RequestLogStore.
 *
 * DynamoDB appears only when DYNAMODB_LOGS_TABLE is set. That keeps an
 * unconfigured driver genuinely inert: the Settings picker maps over this
 * object, and runLogMaintenance maintains every driver in it — so a
 * registered-but-unusable store would both be offered and be called. A stale
 * `logs.store = "dynamodb"` on an unconfigured instance then falls through
 * the existing unknown_driver path to Postgres, which is the right outcome
 * and needs no extra machinery. */
export const DRIVERS: Record<string, RequestLogStore> = {
  postgres: postgresStore,
  ...(dynamodbStore ? { dynamodb: dynamodbStore } : {}),
}
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, 0 failures. In particular `tests/lib/logs/maintenance.test.ts` must stay green — it exercises `runLogMaintenance`, which iterates `DRIVERS`.

- [ ] **Step 5: Explain the absence in the Governance tab**

In `src/app/(admin)/settings/governance-form.tsx`, the store `<Select>` is followed by a `<p className="text-xs text-muted-foreground">` explaining that switching stores does not move existing logs, and then a conditional `activeStore !== store` warning. Add a second paragraph between those two, matching the existing `text-xs text-muted-foreground` (note: `text-xs`, not `text-sm` — every helper line in this form uses `text-xs`):

```tsx
<p className="text-xs text-muted-foreground">
  DynamoDB appears in this list only on instances where{' '}
  <span className="font-mono">DYNAMODB_LOGS_TABLE</span> is set. A driver the
  gateway cannot reach is not offered.
</p>
```

Use `<span className="font-mono">` rather than `<code>`, following the `activeStore` paragraph directly below it.

- [ ] **Step 6: Document the store**

`README.md` has a `## Governance` section containing `### Request logs`, `### Choosing a store`, `### Upgrading from an earlier version`, `### Payload capture`, and `### Retention`. Insert this new subsection **between `### Choosing a store` and `### Upgrading from an earlier version`**, so the store options sit together:

````markdown
### DynamoDB request log store

An alternative to the Postgres store for high write volume. Set these and
restart; the driver appears in Settings → Governance once `DYNAMODB_LOGS_TABLE`
is present.

```bash
DYNAMODB_LOGS_TABLE=babellm_request_logs
AWS_REGION=eu-west-1
```

Credentials come from the default AWS provider chain (environment, SSO, or an
instance/task role). They are never read from the settings table.

**You provision the table**, not the gateway:

| Property | Value |
|---|---|
| Partition key | `pk` (String) |
| Sort key | `sk` (String) |
| TTL attribute | `expiresAt` |
| Billing mode | `PAY_PER_REQUEST` |
| Secondary indexes | none |

The runtime IAM policy needs only:

```
dynamodb:PutItem
dynamodb:GetItem
dynamodb:Query
dynamodb:DescribeTimeToLive
```

Notably not `CreateTable` or `UpdateTimeToLive` — the gateway never creates the
table, so its role never carries permissions it would use once.

**Enable TTL on `expiresAt`.** Without it nothing ever expires, and captured
prompt content outlives the configured retention window. The daily maintenance
run checks this and logs an error if it is missing.

#### How it differs from the Postgres store

- **A filtered page may be short.** Filters are applied after DynamoDB's own
  page limit, so a narrow filter over a wide range can exhaust the read budget
  before filling a page. Paging still works; the page is just smaller.
- **Deletion is best-effort.** DynamoDB may take up to ~48 hours to remove an
  expired item, and it stays queryable until it does.
- **Retention changes are not retroactive.** `expiresAt` is stamped when the
  entry is written, so lowering the retention window does not shorten the life
  of entries already stored. Postgres applies retention retroactively by
  dropping partitions.
- **Payloads are capped at 150 KiB per side**, below the configured payload
  size cap, because a DynamoDB item cannot exceed 400 KB.
````

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/lib/logs/registry.ts src/app/\(admin\)/settings/governance-form.tsx README.md tests/lib/logs/dynamodb/registration.test.ts
git commit -m "feat(logs): register and document the DynamoDB store"
```

---

## Verification

Before claiming completion, run and paste the output of:

```bash
pnpm test:db:up
pnpm typecheck
pnpm lint
pnpm test
```

All must pass. The DynamoDB tests must **run**, not skip — if `tests/lib/logs/dynamodb/store.test.ts` reports skipped tests, `.env.test` is missing `TEST_DYNAMODB_TABLE` and the driver has not actually been exercised. Confirm the count went up rather than sideways.
