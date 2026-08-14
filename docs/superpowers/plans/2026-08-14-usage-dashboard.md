# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-aggregate `request_logs` into an hourly `usage_rollups` table maintained by a watermarked recompute job, and build a `/dashboard` page on top of it that never reads `request_logs`.

**Architecture:** A background job ticks every 60s under a Postgres advisory lock, recomputing whole hour buckets with `DELETE` + `INSERT … SELECT` over a uuid v7 primary-key range. Buckets stay open for two hours so requests that start in one hour and finish in the next are still counted. The dashboard reads only the rollup, so its cost is independent of how large `request_logs` grows.

**Tech Stack:** Next.js 16 (App Router, server components), Drizzle ORM 0.45 + `pg`, Postgres 17, shadcn/ui (`base-nova`, Recharts for charts), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-14-usage-dashboard-design.md`

## Global Constraints

- **Never point tests or a dev server at port 5432.** That is the developer's own database. Tests read `.env.test` (already copied from `.env.test.example` in this worktree) and use the disposable Postgres on **5434**: `pnpm test:db:up`, then `pnpm test`. Browser checks use `pnpm dev:test-db` on port **3001** — never `pnpm dev`.
- **Postgres 17.** `UNIQUE NULLS NOT DISTINCT` (15+) and three-argument `date_trunc(field, timestamptz, zone)` (16+) are available. `uuid_extract_timestamp()` is **not** — it is Postgres 18.
- **Read `node_modules/next/dist/docs/` before writing Next.js code.** This Next version has breaking changes from training data.
- **Build UI out of shadcn components** (`src/components/ui/`). Add missing ones with `pnpm dlx shadcn@latest add <component>`; do not hand-roll equivalents.
- **`SEAL_LAG_HOURS = 2`**, **`MAX_HOURS_PER_TICK = 168`**, **`BACKFILL_HOURS_PER_TICK = 24`**, **`ROLLUP_TICK_MS = 60_000`**.
- **Costs are `numeric(18,9)` and travel as strings.** Never parse a cost into a JS number on the way through the database layer — scale 9 exists because sub-micro-dollar requests must not round to a lying zero.
- **`src/lib/stats/`, not `src/lib/usage/`.** `usage/` is the Redis-backed rate-limit and budget counter store; it answers "may this request proceed" on the hot path. This is Postgres reporting, off the request path.
- Every task ends with tests passing and a commit. Run `pnpm typecheck` and `pnpm lint` before committing in any task that touches TypeScript.

---

### Task 1: The `usage_rollups` table

**Files:**
- Modify: `src/lib/db/schema.ts` (append after `requestLogs`, before the `export type` block)
- Create: `drizzle/0005_*.sql` (generated)
- Modify: `tests/helpers/db.ts:5-9` (add the table to `TABLES`)
- Test: `tests/lib/stats/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `usageRollups` table object, `statusClassEnum`, `type UsageRollupRow = typeof usageRollups.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/schema.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const BUCKET = new Date('2026-08-14T13:00:00Z')

const base = {
  bucket: BUCKET,
  statusClass: 'success' as const,
  requests: 1,
  unpricedRequests: 0,
  promptTokens: 10,
  completionTokens: 20,
  cachedTokens: 0,
  reasoningTokens: 0,
  inputCostUsd: '0.000001000',
  cachedCostUsd: '0',
  outputCostUsd: '0.000002000',
  costUsd: '0.000003000',
  latencySumMs: 500,
  latencyMaxMs: 500,
  latencyCount: 1,
  ttftSumMs: 0,
  ttftCount: 0,
}

test('a rollup row round-trips with nullable dimensions', async () => {
  const [row] = await db.insert(usageRollups).values(base).returning()

  expect(row.apiKeyId).toBeNull()
  expect(row.model).toBeNull()
  expect(row.provider).toBeNull()
  expect(row.costUsd).toBe('0.000003000')
})

test('two rows with the same grain collide even when dimensions are NULL', async () => {
  // Without NULLS NOT DISTINCT, Postgres treats two NULL models as distinct
  // and this second insert succeeds — silently doubling every total the
  // dashboard shows. This test is the only thing standing between that
  // clause and a future migration that quietly drops it.
  await db.insert(usageRollups).values(base)

  await expect(db.insert(usageRollups).values(base)).rejects.toThrow(/duplicate key/)
})

test('rows differing only by model stay distinct', async () => {
  await db.insert(usageRollups).values(base)
  await db.insert(usageRollups).values({ ...base, model: 'gpt-5' })

  const rows = await db.select().from(usageRollups)
  expect(rows).toHaveLength(2)
})

test('cost keeps all nine decimal places', async () => {
  // numeric(18,9), not (12,6): a request costing less than a micro-dollar
  // must not round to 0.000000 on the way into the rollup.
  const [row] = await db
    .insert(usageRollups)
    .values({ ...base, costUsd: '0.000000123' })
    .returning()

  expect(row.costUsd).toBe('0.000000123')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:db:up
pnpm test tests/lib/stats/schema.test.ts
```

Expected: FAIL — `usageRollups` is not exported from `@/lib/db/schema`.

- [ ] **Step 3: Add the enum and table to the schema**

In `src/lib/db/schema.ts`, add `bigint` and `unique` to the existing import from `drizzle-orm/pg-core`, then append after the `requestLogs` definition:

```ts
/** The same three classes `conditions()` in src/lib/logs/postgres.ts derives
 * from `status`, and the same three values as the StatusClass union in
 * src/lib/logs/types.ts. An error rate on the dashboard and a status filter
 * on /logs must mean the same thing; naming them identically in both places
 * is what keeps that true. */
export const statusClassEnum = pgEnum('status_class', [
  'success', 'client_error', 'server_error',
])

/**
 * Hourly pre-aggregation of request_logs, one row per
 * (hour, key, user, model, provider, status class) that actually occurred.
 *
 * Row count grows with distinct traffic shapes per hour, not with request
 * volume — which is the whole point. Reading this table is how the dashboard
 * avoids scanning a log table that grows forever.
 *
 * Never dropped. dropExpiredPartitions() deletes raw logs past the retention
 * window; usage and spend history outlives them here.
 */
export const usageRollups = pgTable(
  'usage_rollups',
  {
    /** Hour start, UTC. Derived from the request's uuid v7 id (its start),
     * never from created_at (its completion) — see the spec §5.2. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),

    // Deliberately NOT a foreign key. `ON DELETE SET NULL` — what
    // request_logs uses — would collide two deleted keys' rows on the unique
    // constraint below and make deleting an API key throw. `ON DELETE
    // CASCADE` would destroy spend history, which request_logs' own comment
    // forbids. So: a plain uuid recording a historical fact, with the name
    // denormalized beside it.
    apiKeyId: uuid('api_key_id'),
    keyName: text('key_name'),

    // Resolved through api_keys at rollup time and then frozen. Reassigning a
    // key to another user changes future buckets and leaves past ones alone:
    // those requests really were made under the old owner.
    userId: uuid('user_id'),
    userName: text('user_name'),

    model: varchar('model', { length: 128 }),
    provider: text('provider'),
    statusClass: statusClassEnum('status_class').notNull(),

    requests: integer('requests').notNull(),
    /** Requests whose cost_usd was NULL. sum(cost_usd) over unpriced requests
     * reads as "$0 spent"; the logs page refuses that lie by rendering
     * "unpriced", and this column is how the dashboard refuses it too. */
    unpricedRequests: integer('unpriced_requests').notNull(),

    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull(),
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull(),

    // Scale 9 matches request_logs exactly. Re-rounding here would
    // reintroduce one layer up the silent zero that column avoids.
    inputCostUsd: numeric('input_cost_usd', { precision: 18, scale: 9 }).notNull(),
    cachedCostUsd: numeric('cached_cost_usd', { precision: 18, scale: 9 }).notNull(),
    outputCostUsd: numeric('output_cost_usd', { precision: 18, scale: 9 }).notNull(),
    costUsd: numeric('cost_usd', { precision: 18, scale: 9 }).notNull(),

    // latency_count is separate from `requests` because ttft_ms is null for
    // every non-streaming request. Dividing both sums by one count would drag
    // average TTFT toward zero in proportion to non-streaming traffic.
    latencySumMs: bigint('latency_sum_ms', { mode: 'number' }).notNull(),
    latencyMaxMs: integer('latency_max_ms').notNull(),
    latencyCount: integer('latency_count').notNull(),
    ttftSumMs: bigint('ttft_sum_ms', { mode: 'number' }).notNull(),
    ttftCount: integer('ttft_count').notNull(),
  },
  (table) => [
    // NULLS NOT DISTINCT (Postgres 15+) is load-bearing: api_key_id, model
    // and provider are all nullable, and by default Postgres considers two
    // NULLs distinct — so without it this constraint would not constrain the
    // rows that need it most, and duplicate buckets would accumulate
    // invisibly, inflating every total on the page.
    unique('usage_rollups_grain_key')
      .on(
        table.bucket, table.apiKeyId, table.userId,
        table.model, table.provider, table.statusClass,
      )
      .nullsNotDistinct(),
    index('usage_rollups_bucket_idx').on(table.bucket),
    index('usage_rollups_key_bucket_idx').on(table.apiKeyId, table.bucket),
    index('usage_rollups_user_bucket_idx').on(table.userId, table.bucket),
    index('usage_rollups_model_bucket_idx').on(table.model, table.bucket),
  ],
)
```

Add to the type block at the bottom:

```ts
export type UsageRollupRow = typeof usageRollups.$inferSelect
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

Read the generated `drizzle/0005_*.sql` and confirm it contains `CREATE TYPE "public"."status_class"`, `CREATE TABLE "usage_rollups"`, and a unique constraint with `NULLS NOT DISTINCT`. If `NULLS NOT DISTINCT` is missing, stop — the constraint is doing nothing and Task 4's correctness depends on it.

- [ ] **Step 5: Add the table to the test reset helper**

In `tests/helpers/db.ts`, add `'usage_rollups'` to `TABLES` as the second entry:

```ts
const TABLES = [
  'request_logs',
  'usage_rollups',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/schema.test.ts
```

Expected: PASS (4 tests). The migration is applied by `tests/setup/global-setup.ts`.

- [ ] **Step 7: Run the full suite, typecheck and lint**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all pass. 874 existing tests must still pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts drizzle tests/helpers/db.ts tests/lib/stats/schema.test.ts
git commit -m "feat(stats): add the usage_rollups table"
```

---

### Task 2: Bucket arithmetic

Pure functions, no database. Every one takes its clock explicitly, so the awkward moments — a seal boundary, a capped catch-up, a finished backfill — are tested by passing a value rather than mocking time. This mirrors `src/lib/logs/partitions.ts`.

**Files:**
- Create: `src/lib/stats/buckets.ts`
- Test: `tests/lib/stats/buckets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HOUR_MS`, `SEAL_LAG_HOURS`, `MAX_HOURS_PER_TICK`, `BACKFILL_HOURS_PER_TICK`
  - `interface HourRange { from: Date; to: Date }` — half-open, `to` exclusive
  - `hourStart(date: Date): Date`
  - `addHours(date: Date, count: number): Date`
  - `unsealedRange(sealedThrough: Date, now: Date): HourRange | null`
  - `nextSealedThrough(previous: Date, covered: HourRange, now: Date): Date`
  - `initialSealedThrough(now: Date): Date`
  - `backfillChunk(backfilledTo: Date, oldestLog: Date): HourRange | null`
  - `type Grain = 'hour' | 'day' | 'month'`
  - `grainFor(from: Date, to: Date): Grain`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/buckets.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  BACKFILL_HOURS_PER_TICK, MAX_HOURS_PER_TICK, SEAL_LAG_HOURS,
  addHours, backfillChunk, grainFor, hourStart, initialSealedThrough,
  nextSealedThrough, unsealedRange,
} from '@/lib/stats/buckets'

const utc = (iso: string) => new Date(iso)

test('hourStart truncates to the hour in UTC', () => {
  expect(hourStart(utc('2026-08-14T13:47:03.123Z')).toISOString())
    .toBe('2026-08-14T13:00:00.000Z')
})

test('hourStart uses UTC, not the local zone', () => {
  // 23:30 UTC is already tomorrow east of Greenwich. Reading the local hour
  // would file the same row in different buckets on different servers.
  expect(hourStart(utc('2026-08-14T23:30:00Z')).toISOString())
    .toBe('2026-08-14T23:00:00.000Z')
})

test('addHours crosses a day boundary', () => {
  expect(addHours(utc('2026-08-14T23:00:00Z'), 2).toISOString())
    .toBe('2026-08-15T01:00:00.000Z')
  expect(addHours(utc('2026-08-15T01:00:00Z'), -2).toISOString())
    .toBe('2026-08-14T23:00:00.000Z')
})

test('unsealedRange covers the first unsealed hour through the current one', () => {
  // Sealed through 10:00 means hour 10 is final; recompute starts at 11:00
  // and runs through the end of the current (partial) hour 13.
  const range = unsealedRange(utc('2026-08-14T10:00:00Z'), utc('2026-08-14T13:20:00Z'))

  expect(range?.from.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(range?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
})

test('unsealedRange returns null when the sealed point is already current', () => {
  // Cannot happen with a lag of 2, but the caller must not have to know that.
  expect(unsealedRange(utc('2026-08-14T13:00:00Z'), utc('2026-08-14T13:20:00Z')))
    .toBeNull()
})

test('unsealedRange caps a long catch-up at MAX_HOURS_PER_TICK', () => {
  // An instance returning after a month must not do it in one transaction.
  const range = unsealedRange(utc('2026-07-01T00:00:00Z'), utc('2026-08-14T13:20:00Z'))

  expect(range?.from.toISOString()).toBe('2026-07-01T01:00:00.000Z')
  expect(range?.to.toISOString())
    .toBe(addHours(utc('2026-07-01T01:00:00Z'), MAX_HOURS_PER_TICK).toISOString())
})

test('nextSealedThrough leaves the last SEAL_LAG_HOURS open', () => {
  // Hour 13 is current, so 12 and 11 stay open for requests that started in
  // them and have not finished yet. 11:00 is the newest sealable hour.
  const covered = { from: utc('2026-08-14T11:00:00Z'), to: utc('2026-08-14T14:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-08-14T10:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(sealed.toISOString())
    .toBe(addHours(hourStart(utc('2026-08-14T13:20:00Z')), -SEAL_LAG_HOURS).toISOString())
})

test('nextSealedThrough seals only what a capped tick actually covered', () => {
  // The catch-up stopped short of the lag limit. Sealing to the lag limit
  // would mark hours final that this tick never computed — they would never
  // be computed at all.
  const covered = { from: utc('2026-07-01T01:00:00Z'), to: utc('2026-07-08T01:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-07-01T00:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-07-08T00:00:00.000Z')
})

test('nextSealedThrough never moves backwards', () => {
  // A clock that jumped back, or a covered range behind the watermark, must
  // not re-open hours that are already sealed.
  const covered = { from: utc('2026-08-14T11:00:00Z'), to: utc('2026-08-14T12:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-08-14T20:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-08-14T20:00:00.000Z')
})

test('initialSealedThrough starts one hour below the first unsealed hour', () => {
  // A first tick must recompute exactly the unsealed window and nothing
  // else; everything older is the backfill's job.
  const now = utc('2026-08-14T13:20:00Z')
  const range = unsealedRange(initialSealedThrough(now), now)

  expect(range?.from.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(range?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
})

test('backfillChunk walks backwards a day at a time', () => {
  const chunk = backfillChunk(utc('2026-08-14T11:00:00Z'), utc('2026-05-01T09:00:00Z'))

  expect(chunk?.to.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(chunk?.from.toISOString())
    .toBe(addHours(utc('2026-08-14T11:00:00Z'), -BACKFILL_HOURS_PER_TICK).toISOString())
})

test('backfillChunk stops at the oldest log rather than overshooting', () => {
  const chunk = backfillChunk(utc('2026-05-02T00:00:00Z'), utc('2026-05-01T09:40:00Z'))

  expect(chunk?.from.toISOString()).toBe('2026-05-01T09:00:00.000Z')
  expect(chunk?.to.toISOString()).toBe('2026-05-02T00:00:00.000Z')
})

test('backfillChunk returns null once the oldest log is covered', () => {
  expect(backfillChunk(utc('2026-05-01T09:00:00Z'), utc('2026-05-01T09:40:00Z'))).toBeNull()
})

test('grainFor picks a resolution the chart can actually render', () => {
  const from = utc('2026-01-01T00:00:00Z')

  expect(grainFor(from, addHours(from, 24))).toBe('hour')
  expect(grainFor(from, addHours(from, 48))).toBe('hour')
  // A year of hourly points is 8,760 of them. Nobody reads that chart.
  expect(grainFor(from, addHours(from, 49))).toBe('day')
  expect(grainFor(from, addHours(from, 90 * 24))).toBe('day')
  expect(grainFor(from, addHours(from, 91 * 24))).toBe('month')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/buckets.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/buckets`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stats/buckets.ts`:

```ts
/**
 * Hour arithmetic and watermark policy for the usage rollup.
 *
 * Every function is pure and takes its clock explicitly, so a seal boundary,
 * a capped catch-up, and a finished backfill are all tested by passing a
 * value rather than by mocking time. Same shape as src/lib/logs/partitions.ts.
 *
 * All ranges are half-open: `from` inclusive, `to` exclusive.
 */

export const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * How long a bucket stays open after its hour ends.
 *
 * A request's id is minted at its start but its row is inserted at its
 * completion, so a stream starting 10:59 and finishing 11:04 lands after
 * hour 10 was first computed. Two hours of grace is what lets the next tick
 * pick it up. A request running longer than this is missed — asserted
 * deliberately in tests/lib/stats/rollup.test.ts rather than left implied.
 */
export const SEAL_LAG_HOURS = 2

/** Caps one tick's recompute, so an instance returning after a long outage
 * catches up over several ticks instead of in one enormous transaction. */
export const MAX_HOURS_PER_TICK = 168

export const BACKFILL_HOURS_PER_TICK = 24

/** Half-open: `from` inclusive, `to` exclusive. */
export interface HourRange {
  from: Date
  to: Date
}

/** Hours align to the epoch, so flooring the timestamp is the UTC hour —
 * no local-zone arithmetic can creep in. */
export function hourStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

export function addHours(date: Date, count: number): Date {
  return new Date(date.getTime() + count * HOUR_MS)
}

/**
 * The hours to recompute this tick: every hour past the watermark, through
 * the end of the current partial hour.
 *
 * `sealedThrough` names the last hour considered final, so the first hour to
 * recompute is the one after it.
 */
export function unsealedRange(sealedThrough: Date, now: Date): HourRange | null {
  const from = addHours(hourStart(sealedThrough), 1)
  const currentEnd = addHours(hourStart(now), 1)
  if (from >= currentEnd) return null

  const capped = addHours(from, MAX_HOURS_PER_TICK)
  return { from, to: capped < currentEnd ? capped : currentEnd }
}

/**
 * How far the watermark may advance after covering `covered`.
 *
 * Two bounds, and the lower one wins. The lag limit keeps recent hours open
 * for late arrivals; the covered range matters when a capped tick stopped
 * short of it, because sealing past what was actually computed would mark
 * hours final that nothing ever aggregated.
 *
 * Never returns a value below `previous`: a clock that jumped backwards must
 * not re-open sealed hours.
 */
export function nextSealedThrough(previous: Date, covered: HourRange, now: Date): Date {
  const lagLimit = addHours(hourStart(now), -SEAL_LAG_HOURS)
  const coveredLast = addHours(covered.to, -1)
  const candidate = coveredLast < lagLimit ? coveredLast : lagLimit
  return candidate > previous ? candidate : previous
}

/** The watermark a database with no rollup state starts from: exactly one
 * unsealed window behind. Everything older belongs to the backfill. */
export function initialSealedThrough(now: Date): Date {
  return addHours(hourStart(now), -(SEAL_LAG_HOURS + 1))
}

/**
 * The next chunk of history to aggregate, walking backwards from
 * `backfilledTo` toward `oldestLog`. Null once there is nothing older.
 *
 * Backwards because recent history is the most useful: the default 7d view
 * is populated within minutes of first boot while last year fills in over
 * the following hours.
 */
export function backfillChunk(backfilledTo: Date, oldestLog: Date): HourRange | null {
  const to = hourStart(backfilledTo)
  const floor = hourStart(oldestLog)
  if (to <= floor) return null

  const from = addHours(to, -BACKFILL_HOURS_PER_TICK)
  return { from: from > floor ? from : floor, to }
}

export type Grain = 'hour' | 'day' | 'month'

/**
 * Derived from the range rather than chosen by the user: one knob fewer, and
 * a year-long range can never render 8,760 points.
 */
export function grainFor(from: Date, to: Date): Grain {
  const days = (to.getTime() - from.getTime()) / DAY_MS
  if (days <= 2) return 'hour'
  if (days <= 90) return 'day'
  return 'month'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/buckets.test.ts
```

Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/buckets.ts tests/lib/stats/buckets.test.ts
git commit -m "feat(stats): hour bucket and watermark arithmetic"
```

---

### Task 3: Reading the hour back out of a uuid v7

The single most load-bearing expression in this feature, and the one most likely to be silently wrong. It gets its own task and its own round-trip test against `uuidv7Bound`.

**Files:**
- Create: `src/lib/stats/sql.ts`
- Test: `tests/lib/stats/sql.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `bucketExpr(alias: string): string` — SQL text for the UTC hour of a uuid v7 `id` column on the given table alias.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/sql.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { pool } from '@/lib/db'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'
import { bucketExpr } from '@/lib/stats/sql'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

/** Runs the expression against a literal uuid, with no table involved. */
async function hourOf(id: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT ${bucketExpr('t')} AS bucket FROM (SELECT $1::uuid AS id) t`,
    [id],
  )
  return (rows[0].bucket as Date).toISOString()
}

test('the expression yields the UTC hour the uuid encodes', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-14T13:37:04.512Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('it agrees with uuidv7Bound at an hour boundary', async () => {
  // uuidv7Bound is what every time-range query in this codebase uses to turn
  // an instant into a primary-key bound. If the two ever disagreed, the job
  // would delete rows for one hour and insert rows for another.
  expect(await hourOf(uuidv7Bound(new Date('2026-08-14T13:00:00Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('the last millisecond of an hour stays in that hour', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-14T13:59:59.999Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('it truncates in UTC across a DST boundary', async () => {
  // date_trunc on a timestamptz truncates in the session TimeZone unless a
  // zone is named. Under Europe/Paris the two-argument form puts this row an
  // hour out; the three-argument form does not.
  await pool.query("SET TIME ZONE 'Europe/Paris'")
  try {
    expect(await hourOf(uuidv7(new Date('2026-03-29T01:30:00Z'))))
      .toBe('2026-03-29T01:00:00.000Z')
  } finally {
    await pool.query('SET TIME ZONE DEFAULT')
  }
})

test('it handles a month boundary', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-31T23:15:00Z'))))
    .toBe('2026-08-31T23:00:00.000Z')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/sql.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/sql`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stats/sql.ts`:

```ts
/**
 * The UTC hour a uuid v7 encodes, as SQL.
 *
 * Postgres 18 has uuid_extract_timestamp(); compose pins postgres:17, which
 * is also why src/lib/uuid.ts mints ids in the application. So the timestamp
 * is unpacked here by hand:
 *
 *   - the first 48 bits of a v7 uuid are a big-endian millisecond timestamp
 *   - which is exactly the first 12 hex characters of the dashless text form
 *   - `'x' || hex` cast to bit(48) is Postgres's hex bit-string literal
 *   - and to_timestamp() takes it from milliseconds to a timestamptz
 *
 * The zone argument to date_trunc is not optional decoration. Without it,
 * date_trunc truncates a timestamptz in the session's TimeZone, so the same
 * row would land in different buckets on connections with different settings
 * — and every total would depend on who asked. Three-argument date_trunc is
 * Postgres 16+.
 *
 * The counterpart of uuidv7Bound(): that turns an instant into a key bound,
 * this turns a key back into an instant. tests/lib/stats/sql.test.ts asserts
 * the two agree, because a disagreement would have the rollup job deleting
 * rows for one hour and inserting rows for another.
 */
export function bucketExpr(alias: string): string {
  return `date_trunc('hour', to_timestamp(` +
    `('x' || substring(replace(${alias}.id::text, '-', '') from 1 for 12))::bit(48)::bigint` +
    ` / 1000.0), 'UTC')`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/sql.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/sql.ts tests/lib/stats/sql.test.ts
git commit -m "feat(stats): decode the uuid v7 hour in SQL"
```

---

### Task 4: The recompute

The heart of the design: delete an hour range and rebuild it from a primary-key scan, in one transaction. Idempotent by construction.

**Files:**
- Create: `src/lib/stats/aggregate.ts`
- Create: `tests/helpers/stats.ts`
- Test: `tests/lib/stats/aggregate.test.ts`

**Interfaces:**
- Consumes: `HourRange` (Task 2), `bucketExpr` (Task 3).
- Produces:
  - `interface RollupClient { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }`
  - `aggregateRange(client: RollupClient, range: HourRange): Promise<number>` — returns rows written. Caller owns the transaction.
- Test helper produces: `insertLog(overrides): Promise<string>` in `tests/helpers/stats.ts`.

- [ ] **Step 1: Write the test helper**

Create `tests/helpers/stats.ts`:

```ts
import { db } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { uuidv7 } from '@/lib/uuid'

type LogOverrides = Partial<typeof requestLogs.$inferInsert> & { at?: Date }

/**
 * Inserts one request_logs row with sane defaults.
 *
 * `at` sets the request's *start*, which is the uuid v7 id and therefore the
 * bucket the rollup files it under — deliberately independent of created_at,
 * so a test can insert a row "late" the way a long stream really does.
 */
export async function insertLog({ at, ...overrides }: LogOverrides = {}): Promise<string> {
  const id = overrides.id ?? uuidv7(at ?? new Date())
  await db.insert(requestLogs).values({
    id,
    model: 'gpt-5',
    stream: false,
    status: 200,
    outcome: 'ok',
    latencyMs: 500,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    inputCostUsd: '0.000100000',
    cachedCostUsd: '0',
    outputCostUsd: '0.000200000',
    costUsd: '0.000300000',
    finalProvider: 'openai',
    ...overrides,
  })
  return id
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/lib/stats/aggregate.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { apiKeys, requestLogs, usageRollups, users } from '@/lib/db/schema'
import { aggregateRange } from '@/lib/stats/aggregate'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const HOUR = new Date('2026-08-14T13:00:00Z')
const RANGE = { from: HOUR, to: new Date('2026-08-14T14:00:00Z') }

const at = (iso: string) => new Date(iso)

async function rollups() {
  return db.select().from(usageRollups).orderBy(asc(usageRollups.bucket))
}

/** Runs one recompute the way the job does: inside a transaction. */
async function run(range = RANGE): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const rows = await aggregateRange(client, range)
    await client.query('COMMIT')
    return rows
  } finally {
    client.release()
  }
}

test('requests in one hour collapse into one row', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await insertLog({ at: at('2026-08-14T13:45:00Z') })

  expect(await run()).toBe(1)

  const [row] = await rollups()
  expect(row.bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
  expect(row.requests).toBe(2)
  expect(row.promptTokens).toBe(200)
  expect(row.completionTokens).toBe(100)
  expect(row.costUsd).toBe('0.000600000')
  expect(row.model).toBe('gpt-5')
  expect(row.provider).toBe('openai')
  expect(row.statusClass).toBe('success')
})

test('requests in different hours land in different buckets', async () => {
  await insertLog({ at: at('2026-08-14T13:30:00Z') })
  await insertLog({ at: at('2026-08-14T14:30:00Z') })

  await run({ from: HOUR, to: at('2026-08-14T15:00:00Z') })

  const rows = await rollups()
  expect(rows.map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T13:00:00.000Z',
    '2026-08-14T14:00:00.000Z',
  ])
})

test('status maps to the same three classes /logs filters by', async () => {
  await insertLog({ at: at('2026-08-14T13:01:00Z'), status: 200 })
  await insertLog({ at: at('2026-08-14T13:02:00Z'), status: 429, outcome: 'error' })
  await insertLog({ at: at('2026-08-14T13:03:00Z'), status: 500, outcome: 'error' })

  await run()

  const rows = await rollups()
  expect(rows.map((r) => r.statusClass).sort())
    .toEqual(['client_error', 'server_error', 'success'])
})

test('running the same range twice produces identical rows', async () => {
  // Idempotency is the entire premise of recompute-over-increment. Without
  // this test that premise is a claim, and a double-counting regression would
  // show up as numbers that are merely wrong rather than as a failure.
  await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await insertLog({ at: at('2026-08-14T13:45:00Z') })

  await run()
  const first = await rollups()
  await run()
  const second = await rollups()

  expect(second).toEqual(first)
})

test('a combination that stopped occurring is removed, not left behind', async () => {
  // The other half of what recompute buys over increment.
  const id = await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await run()
  expect(await rollups()).toHaveLength(1)

  await db.delete(requestLogs).where(eq(requestLogs.id, id))
  await run()

  expect(await rollups()).toHaveLength(0)
})

test('a key renamed mid-hour produces one row, not a unique violation', async () => {
  // request_logs.key_name is denormalized at write time, so a rename puts two
  // names on rows sharing every grain column. Grouping by the name would emit
  // two rows for one grain and the unique constraint would reject the second
  // — the tick would fail, and keep failing until that bucket sealed.
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'before', keyHash: 'h1', keyPrefix: 'sk-a' })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'before' })
  await insertLog({ at: at('2026-08-14T13:45:00Z'), apiKeyId: key.id, keyName: 'after' })

  expect(await run()).toBe(1)

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(['before', 'after']).toContain(row.keyName)
})

test('the user is resolved through the key and frozen on the row', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'ada-key', keyHash: 'h2', keyPrefix: 'sk-b', userId: user.id })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'ada-key' })
  await run()

  const [row] = await rollups()
  expect(row.userId).toBe(user.id)
  expect(row.userName).toBe('Ada')
})

test('unpriced requests are counted, not silently worth zero', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await insertLog({
    at: at('2026-08-14T13:10:00Z'),
    inputCostUsd: null, cachedCostUsd: null, outputCostUsd: null, costUsd: null,
  })

  await run()

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(row.unpricedRequests).toBe(1)
  expect(row.costUsd).toBe('0.000300000')
})

test('non-streaming requests do not drag the TTFT denominator', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z'), stream: true, ttftMs: 300 })
  await insertLog({ at: at('2026-08-14T13:10:00Z'), ttftMs: null })

  await run()

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(row.ttftCount).toBe(1)
  expect(row.ttftSumMs).toBe(300)
  expect(row.latencyCount).toBe(2)
})

test('latency carries a sum, a count and a max', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z'), latencyMs: 100 })
  await insertLog({ at: at('2026-08-14T13:10:00Z'), latencyMs: 900 })

  await run()

  const [row] = await rollups()
  expect(row.latencySumMs).toBe(1000)
  expect(row.latencyCount).toBe(2)
  expect(row.latencyMaxMs).toBe(900)
})

test('rows outside the range are untouched', async () => {
  await insertLog({ at: at('2026-08-14T12:30:00Z') })
  await insertLog({ at: at('2026-08-14T13:30:00Z') })

  await run()

  const rows = await rollups()
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
})

test('deleting an API key leaves its rollup rows intact', async () => {
  // request_logs uses ON DELETE SET NULL; usage_rollups has no foreign key at
  // all, because SET NULL on a column inside the unique constraint would make
  // this delete fail once two keys' rows collapsed onto the same NULL grain.
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'doomed', keyHash: 'h3', keyPrefix: 'sk-c' })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'doomed' })
  await run()

  await db.delete(apiKeys)

  const [row] = await rollups()
  expect(row.apiKeyId).toBe(key.id)
  expect(row.keyName).toBe('doomed')
})
```

Add the two imports the deletion test needs at the top of the file:

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/aggregate.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/aggregate`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/stats/aggregate.ts`:

```ts
import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'
import type { HourRange } from './buckets'
import { bucketExpr } from './sql'

/** The subset of a `pg` client this module needs. Narrow on purpose: the
 * caller owns the transaction and the connection, because the lock in
 * rollup.ts must be taken on the same session. */
export interface RollupClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/**
 * Rebuilds every rollup bucket in `range` from request_logs.
 *
 * Delete-and-reinsert, never `ON CONFLICT DO UPDATE SET x = x + excluded.x`.
 * Incrementing is correct only if every row is counted exactly once, and
 * nothing here provides that invariant: a retried tick, an overlapping range,
 * or a partially-failed run each double-counts silently and permanently, with
 * no way to detect it afterwards and no repair short of a full rebuild.
 * Recompute converges on the same numbers however many times it runs, and it
 * also removes a combination that stopped occurring — which an increment
 * never does.
 *
 * The caller opens the transaction: a DELETE that commits without its INSERT
 * would leave those hours permanently zeroed.
 *
 * Returns the number of rollup rows written.
 */
export async function aggregateRange(
  client: RollupClient,
  range: HourRange,
): Promise<number> {
  await client.query(
    'DELETE FROM usage_rollups WHERE bucket >= $1 AND bucket < $2',
    [range.from, range.to],
  )

  // The id range is the same primary-key trick /logs uses for its date
  // filters (src/lib/logs/postgres.ts:49): a v7 id encodes its own timestamp,
  // so a time window is a PK range scan with partition pruning rather than a
  // sequential scan over a table that grows forever.
  const result = await client.query(
    `
    INSERT INTO usage_rollups (
      bucket, api_key_id, user_id, model, provider, status_class,
      key_name, user_name,
      requests, unpriced_requests,
      prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
      input_cost_usd, cached_cost_usd, output_cost_usd, cost_usd,
      latency_sum_ms, latency_max_ms, latency_count, ttft_sum_ms, ttft_count
    )
    SELECT
      ${bucketExpr('rl')},
      rl.api_key_id,
      ak.user_id,
      rl.model,
      rl.final_provider,
      (CASE
         WHEN rl.status < 400 THEN 'success'
         WHEN rl.status < 500 THEN 'client_error'
         ELSE 'server_error'
       END)::status_class,
      -- Labels, not grain. key_name is denormalized into request_logs at
      -- write time, so renaming a key mid-hour puts two names on rows sharing
      -- every grain column; grouping by the name would emit two rows for one
      -- grain and the unique constraint would reject the second.
      max(rl.key_name),
      max(u.name),
      count(*)::int,
      (count(*) FILTER (WHERE rl.cost_usd IS NULL))::int,
      coalesce(sum(rl.prompt_tokens), 0),
      coalesce(sum(rl.completion_tokens), 0),
      coalesce(sum(rl.cached_tokens), 0),
      coalesce(sum(rl.reasoning_tokens), 0),
      coalesce(sum(rl.input_cost_usd), 0),
      coalesce(sum(rl.cached_cost_usd), 0),
      coalesce(sum(rl.output_cost_usd), 0),
      coalesce(sum(rl.cost_usd), 0),
      coalesce(sum(rl.latency_ms), 0),
      coalesce(max(rl.latency_ms), 0),
      count(rl.latency_ms)::int,
      coalesce(sum(rl.ttft_ms), 0),
      count(rl.ttft_ms)::int
    FROM request_logs rl
    LEFT JOIN api_keys ak ON ak.id = rl.api_key_id
    LEFT JOIN users u ON u.id = ak.user_id
    WHERE rl.id >= $1 AND rl.id < $2
    GROUP BY 1, 2, 3, 4, 5, 6
    `,
    [uuidv7Bound(range.from), uuidv7Bound(range.to)],
  )

  return result.rowCount ?? 0
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/aggregate.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/aggregate.ts tests/helpers/stats.ts tests/lib/stats/aggregate.test.ts
git commit -m "feat(stats): recompute usage rollups over an hour range"
```

---

### Task 5: Rollup state

**Files:**
- Create: `src/lib/stats/state.ts`
- Test: `tests/lib/stats/state.test.ts`

**Interfaces:**
- Consumes: `initialSealedThrough` (Task 2), `bucketExpr` (Task 3).
- Produces:
  - `ROLLUP_STATE_KEY = 'usage.rollup_state'`
  - `interface RollupState { sealedThrough: Date; backfilledTo: Date | null; oldestLog: Date | null }`
  - `readRollupState(now: Date): Promise<RollupState>`
  - `writeRollupState(state: RollupState, now: Date): Promise<void>`
  - `oldestLogHour(): Promise<Date | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/state.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { initialSealedThrough } from '@/lib/stats/buckets'
import {
  ROLLUP_STATE_KEY, oldestLogHour, readRollupState, writeRollupState,
} from '@/lib/stats/state'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const NOW = new Date('2026-08-14T13:20:00Z')

test('a database with no state starts one unsealed window behind', async () => {
  const state = await readRollupState(NOW)

  expect(state.sealedThrough.toISOString())
    .toBe(initialSealedThrough(NOW).toISOString())
  expect(state.backfilledTo).toBeNull()
  expect(state.oldestLog).toBeNull()
})

test('state round-trips through the settings row', async () => {
  await writeRollupState({
    sealedThrough: new Date('2026-08-14T11:00:00Z'),
    backfilledTo: new Date('2026-08-14T11:00:00Z'),
    oldestLog: new Date('2026-05-01T09:00:00Z'),
  }, NOW)

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(state.backfilledTo?.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(state.oldestLog?.toISOString()).toBe('2026-05-01T09:00:00.000Z')
})

test('writing twice updates the row rather than failing on the primary key', async () => {
  const base = { backfilledTo: null, oldestLog: null }
  await writeRollupState({ ...base, sealedThrough: new Date('2026-08-14T10:00:00Z') }, NOW)
  await writeRollupState({ ...base, sealedThrough: new Date('2026-08-14T11:00:00Z') }, NOW)

  const rows = await db.select().from(settings).where(eq(settings.key, ROLLUP_STATE_KEY))
  expect(rows).toHaveLength(1)
  expect((await readRollupState(NOW)).sealedThrough.toISOString())
    .toBe('2026-08-14T11:00:00.000Z')
})

test('a corrupt state row degrades to the default rather than throwing', async () => {
  // Hand-edited settings must not wedge the job forever.
  await db.insert(settings).values({ key: ROLLUP_STATE_KEY, value: { sealedThrough: 'nonsense' } })

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString())
    .toBe(initialSealedThrough(NOW).toISOString())
})

test('oldestLogHour is null on an empty table', async () => {
  expect(await oldestLogHour()).toBeNull()
})

test('oldestLogHour is the hour of the earliest request', async () => {
  await insertLog({ at: new Date('2026-05-01T09:40:00Z') })
  await insertLog({ at: new Date('2026-06-01T09:40:00Z') })

  expect((await oldestLogHour())?.toISOString()).toBe('2026-05-01T09:00:00.000Z')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/state.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/state`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stats/state.ts`:

```ts
import 'server-only'
import { db, pool } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { initialSealedThrough } from './buckets'
import { bucketExpr } from './sql'

/** One settings row, the same pattern as `logs.last_maintenance`. */
export const ROLLUP_STATE_KEY = 'usage.rollup_state'

export interface RollupState {
  /** The last hour considered final. Recompute starts at the hour after it. */
  sealedThrough: Date
  /** The oldest hour the backfill has reached. Null until the first tick. */
  backfilledTo: Date | null
  /** The hour of the earliest surviving request log. Null until measured. */
  oldestLog: Date | null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Reads the watermark, degrading to a fresh start on anything unreadable.
 *
 * A hand-edited or half-written settings row must not wedge the job forever:
 * the worst case of starting over is a redundant recompute of the unsealed
 * window, which is idempotent anyway.
 */
export async function readRollupState(now: Date): Promise<RollupState> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ROLLUP_STATE_KEY))
  const value = (row?.value ?? {}) as Record<string, unknown>

  return {
    sealedThrough: parseDate(value.sealedThrough) ?? initialSealedThrough(now),
    backfilledTo: parseDate(value.backfilledTo),
    oldestLog: parseDate(value.oldestLog),
  }
}

export async function writeRollupState(state: RollupState, now: Date): Promise<void> {
  const value = {
    sealedThrough: state.sealedThrough.toISOString(),
    backfilledTo: state.backfilledTo?.toISOString() ?? null,
    oldestLog: state.oldestLog?.toISOString() ?? null,
    at: now.toISOString(),
  }

  await db
    .insert(settings)
    .values({ key: ROLLUP_STATE_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
}

/**
 * The hour of the earliest surviving request log, or null if there are none.
 *
 * Measured once and stored, because it only moves when a partition is
 * dropped — and a stale value merely makes the backfill walk into empty
 * hours, which costs one no-op recompute and then finishes.
 *
 * min(id) is a per-partition index scan, not a table scan.
 */
export async function oldestLogHour(): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT ${bucketExpr('t')} AS hour FROM (SELECT min(id) AS id FROM request_logs) t
      WHERE t.id IS NOT NULL`,
  )
  return (rows[0]?.hour as Date | undefined) ?? null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/state.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/state.ts tests/lib/stats/state.test.ts
git commit -m "feat(stats): persist the rollup watermark"
```

---

### Task 6: The tick and its advisory lock

**Files:**
- Create: `src/lib/stats/rollup.ts`
- Test: `tests/lib/stats/rollup.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `ROLLUP_LOCK_KEY: bigint`
  - `interface RollupRun { recomputed: HourRange | null; rows: number; backfilled: HourRange | null }`
  - `runUsageRollup(now?: Date): Promise<RollupRun | null>` — null when the lock was held.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/rollup.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { asc } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import { addHours } from '@/lib/stats/buckets'
import { ROLLUP_LOCK_KEY, runUsageRollup } from '@/lib/stats/rollup'
import { readRollupState } from '@/lib/stats/state'
import { PARTITION_LOCK_KEY } from '@/lib/logs/maintenance'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const NOW = new Date('2026-08-14T13:20:00Z')
const at = (iso: string) => new Date(iso)

async function rollups() {
  return db.select().from(usageRollups).orderBy(asc(usageRollups.bucket))
}

test('the lock key is not the partition maintenance key', () => {
  // Sharing one would make a per-minute job and a daily job block each other
  // for no reason.
  expect(ROLLUP_LOCK_KEY).not.toBe(PARTITION_LOCK_KEY)
})

test('a tick aggregates the unsealed window', async () => {
  await insertLog({ at: at('2026-08-14T12:30:00Z') })
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  const run = await runUsageRollup(NOW)

  expect(run?.recomputed?.from.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(run?.recomputed?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
  expect((await rollups()).map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T12:00:00.000Z',
    '2026-08-14T13:00:00.000Z',
  ])
})

test('the watermark advances but leaves the lag open', async () => {
  await runUsageRollup(NOW)

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString()).toBe('2026-08-14T11:00:00.000Z')
})

test('two ticks produce the same rows', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  await runUsageRollup(NOW)
  const first = await rollups()
  await runUsageRollup(NOW)

  expect(await rollups()).toEqual(first)
})

test('a row arriving late but inside the seal lag is picked up', async () => {
  // The row's id says 12:59 — a stream that started then and finished now.
  // Hour 12 was already computed by the first tick and must be recomputed.
  await runUsageRollup(NOW)
  expect(await rollups()).toHaveLength(0)

  await insertLog({ at: at('2026-08-14T12:59:00Z') })
  await runUsageRollup(NOW)

  const rows = await rollups()
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket.toISOString()).toBe('2026-08-14T12:00:00.000Z')
})

test('a row arriving after its hour sealed is missed', async () => {
  // The documented boundary of SEAL_LAG_HOURS, asserted rather than implied.
  // A request running longer than the lag is not counted. If this test ever
  // fails because the row IS counted, the lag was raised — update the spec.
  await runUsageRollup(NOW)

  await insertLog({ at: at('2026-08-14T09:30:00Z') })
  await runUsageRollup(NOW)

  expect(await rollups()).toHaveLength(0)
})

test('a held lock makes the tick skip rather than run concurrently', async () => {
  // Two instances interleaving inside DELETE-then-INSERT can leave an hour
  // permanently zeroed, and the unique constraint cannot catch it because
  // deleting rows violates nothing.
  const holder = await pool.connect()
  try {
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])

    expect(await runUsageRollup(NOW)).toBeNull()
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])
    holder.release()
  }
})

test('the lock is released, so the next tick runs', async () => {
  // The trap this guards: a lock taken on one pooled client and released on
  // another leaks silently, and every later tick skips forever.
  await runUsageRollup(NOW)
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  expect(await runUsageRollup(NOW)).not.toBeNull()
  expect(await rollups()).toHaveLength(1)
})

test('backfill walks backwards into history over successive ticks', async () => {
  await insertLog({ at: at('2026-08-11T09:30:00Z') })
  await insertLog({ at: at('2026-08-13T09:30:00Z') })

  // First tick: the unsealed window only, and history is not yet covered.
  await runUsageRollup(NOW)
  expect(await rollups()).toHaveLength(0)

  // Each further tick pulls one day older.
  await runUsageRollup(NOW)
  expect((await rollups()).map((r) => r.bucket.toISOString()))
    .toContain('2026-08-13T09:00:00.000Z')

  for (let i = 0; i < 4; i += 1) await runUsageRollup(NOW)

  expect((await rollups()).map((r) => r.bucket.toISOString()))
    .toContain('2026-08-11T09:00:00.000Z')
})

test('backfill stops once the oldest log is covered', async () => {
  await insertLog({ at: at('2026-08-13T09:30:00Z') })

  for (let i = 0; i < 6; i += 1) await runUsageRollup(NOW)
  const state = await readRollupState(NOW)

  const run = await runUsageRollup(NOW)
  expect(run?.backfilled).toBeNull()
  expect((await readRollupState(NOW)).backfilledTo?.toISOString())
    .toBe(state.backfilledTo?.toISOString())
})

test('a long catch-up is chunked rather than done in one transaction', async () => {
  // Sealed a year ago: the tick must cover MAX_HOURS_PER_TICK and no more.
  await runUsageRollup(NOW)
  const { sealedThrough } = await readRollupState(NOW)
  const later = addHours(sealedThrough, 24 * 400)

  const run = await runUsageRollup(later)

  const hours = (run!.recomputed!.to.getTime() - run!.recomputed!.from.getTime()) / 3_600_000
  expect(hours).toBe(168)
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/rollup.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/rollup`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stats/rollup.ts`:

```ts
import 'server-only'
import { pool } from '@/lib/db'
import { aggregateRange } from './aggregate'
import { backfillChunk, nextSealedThrough, unsealedRange, type HourRange } from './buckets'
import { oldestLogHour, readRollupState, writeRollupState } from './state'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from
 * PARTITION_LOCK_KEY in src/lib/logs/maintenance.ts — a per-minute job and a
 * daily job must not block each other. */
export const ROLLUP_LOCK_KEY = BigInt(7_713_204_558_930_141)

export interface RollupRun {
  recomputed: HourRange | null
  rows: number
  backfilled: HourRange | null
}

/**
 * One rollup tick: recompute the unsealed window, advance the watermark, and
 * pull one chunk of history backwards.
 *
 * Returns null when another instance holds the lock.
 *
 * `pg_try_advisory_lock`, not the blocking form: a losing tick means someone
 * else is already doing this minute's work, and the next tick is 60 seconds
 * away. Blocking would queue ticks behind each other and stack them without
 * bound if one wedged. (runLogMaintenance blocks on the boot path for the
 * opposite reason: an instance must not start serving with no partitions.)
 */
export async function runUsageRollup(now: Date = new Date()): Promise<RollupRun | null> {
  // pg_try_advisory_lock and pg_advisory_unlock are scoped to the session
  // that took them. `db` wraps a shared pool: a bare db.execute() checks out
  // *some* idle client, runs one statement and hands it back, so the lock and
  // its unlock could land on two different backends. The unlock would no-op
  // on a connection that never held the lock, leaking it on the one that did
  // — and every later tick would then find it held and skip, forever, with
  // nothing in the logs. Pinning both calls to one client is the fix.
  const client = await pool.connect()
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [ROLLUP_LOCK_KEY.toString()],
    )
    if (!locked.rows[0]?.locked) return null

    try {
      const state = await readRollupState(now)
      const run: RollupRun = { recomputed: null, rows: 0, backfilled: null }

      const unsealed = unsealedRange(state.sealedThrough, now)
      if (unsealed) {
        // One transaction: a DELETE that committed without its INSERT would
        // leave those hours permanently zeroed.
        run.rows += await inTransaction(client, unsealed)
        run.recomputed = unsealed
        state.sealedThrough = nextSealedThrough(state.sealedThrough, unsealed, now)
        // The first tick establishes where history begins for the backfill:
        // everything from here backwards is its job.
        state.backfilledTo ??= unsealed.from
      }

      state.oldestLog ??= await oldestLogHour()

      if (state.backfilledTo && state.oldestLog) {
        const chunk = backfillChunk(state.backfilledTo, state.oldestLog)
        if (chunk) {
          run.rows += await inTransaction(client, chunk)
          run.backfilled = chunk
          state.backfilledTo = chunk.from
        }
      }

      await writeRollupState(state, now)
      return run
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])
      } catch (err) {
        // The run's outcome is already decided. Rethrowing here would replace
        // a real failure with the unlock's and hide the root cause, so it is
        // logged and carried to release() below, which destroys a client that
        // may still hold the lock rather than recycling it.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error('[gateway] could not release the usage rollup lock', err)
      }
    }
  } finally {
    client.release(unlockError)
  }
}

async function inTransaction(
  client: Awaited<ReturnType<typeof pool.connect>>,
  range: HourRange,
): Promise<number> {
  await client.query('BEGIN')
  try {
    const rows = await aggregateRange(client, range)
    await client.query('COMMIT')
    return rows
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/rollup.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/rollup.ts tests/lib/stats/rollup.test.ts
git commit -m "feat(stats): rollup tick under an advisory lock"
```

---

### Task 7: Start the job

**Files:**
- Modify: `src/lib/stats/rollup.ts` (append)
- Modify: `src/instrumentation.ts`
- Test: `tests/lib/stats/scheduler.test.ts`

**Interfaces:**
- Consumes: `runUsageRollup` (Task 6).
- Produces: `ROLLUP_TICK_MS`, `startUsageRollup(): Promise<void>`, `stopUsageRollup(): void` (test-only teardown).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db, pool } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import { ROLLUP_TICK_MS, startUsageRollup, stopUsageRollup } from '@/lib/stats/rollup'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)
afterEach(() => {
  stopUsageRollup()
  vi.restoreAllMocks()
})

test('the first tick runs before the call returns', async () => {
  await insertLog()

  await startUsageRollup()

  expect(await db.select().from(usageRollups)).not.toHaveLength(0)
})

test('starting twice does not schedule two timers', async () => {
  // Next may evaluate a module more than once in development.
  await startUsageRollup()
  await startUsageRollup()

  expect(ROLLUP_TICK_MS).toBe(60_000)
})

test('a failing tick is logged and swallowed', async () => {
  // A reporting problem must not become a serving problem — the same
  // hierarchy of concerns startPartitionMaintenance states. A database the
  // job cannot reach must not stop the instance from serving requests.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(pool, 'connect').mockRejectedValueOnce(new Error('boom'))

  await expect(startUsageRollup()).resolves.toBeUndefined()
  expect(error).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/scheduler.test.ts
```

Expected: FAIL — `startUsageRollup` is not exported.

- [ ] **Step 3: Append the scheduler to `src/lib/stats/rollup.ts`**

```ts
export const ROLLUP_TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null

/**
 * Runs one tick now, then every ROLLUP_TICK_MS.
 *
 * The first run is awaited so a freshly started instance serves a dashboard
 * with data in it rather than an empty one.
 *
 * A failure is logged and swallowed rather than propagated: a reporting
 * problem must not become a serving problem, the same hierarchy of concerns
 * startPartitionMaintenance states. It is logged loudly because the
 * consequence is a silently stale dashboard rather than a visibly broken
 * page.
 *
 * Idempotent, because Next may evaluate a module more than once in
 * development.
 */
export async function startUsageRollup(): Promise<void> {
  if (timer) return

  timer = setInterval(() => {
    void runUsageRollup().catch((err) =>
      console.error('[gateway] usage rollup tick failed', err),
    )
  }, ROLLUP_TICK_MS)
  // Never hold the process open for a reporting job.
  timer.unref()

  try {
    await runUsageRollup()
  } catch (err) {
    console.error('[gateway] initial usage rollup failed', err)
  }
}

/** Test teardown. Production never stops the job. */
export function stopUsageRollup(): void {
  if (timer) clearInterval(timer)
  timer = null
}
```

- [ ] **Step 4: Wire it into instrumentation**

Replace the body of `register()` in `src/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { startPartitionMaintenance } = await import('@/lib/logs/maintenance')
  await startPartitionMaintenance()

  // After partition maintenance, not before: a fresh database has no
  // partitions until that call returns, and a rollup reading request_logs
  // before they exist would be aggregating a table that cannot yet be
  // written to.
  const { startUsageRollup } = await import('@/lib/stats/rollup')
  await startUsageRollup()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/scheduler.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/rollup.ts src/instrumentation.ts tests/lib/stats/scheduler.test.ts
git commit -m "feat(stats): run the rollup job on a timer"
```

---

### Task 8: The read layer

**Files:**
- Create: `src/lib/stats/types.ts`
- Create: `src/lib/stats/query.ts`
- Test: `tests/lib/stats/query.test.ts`

**Interfaces:**
- Consumes: `usageRollups` (Task 1), `Grain` / `grainFor` (Task 2).
- Produces (in `types.ts`):
  ```ts
  export interface UsageFilter { from: Date; to: Date; apiKeyId?: string; userId?: string; model?: string }
  export interface UsageTotals {
    requests: number; errorRequests: number; unpricedRequests: number
    promptTokens: number; completionTokens: number; cachedTokens: number
    costUsd: string; avgLatencyMs: number | null; maxLatencyMs: number | null
    avgTtftMs: number | null
  }
  export interface UsagePoint { bucket: Date; success: number; clientError: number; serverError: number; costUsd: string }
  export type BreakdownDimension = 'model' | 'key' | 'user' | 'provider'
  export interface BreakdownRow { id: string | null; label: string; requests: number; errorRequests: number; tokens: number; costUsd: string }
  ```
- Produces (in `query.ts`): `loadTotals`, `loadSeries`, `loadBreakdown`, `loadRollupModels`, `EMPTY_TOTALS`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/stats/query.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys, usageRollups, users } from '@/lib/db/schema'
import { loadBreakdown, loadRollupModels, loadSeries, loadTotals } from '@/lib/stats/query'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const FROM = new Date('2026-08-14T00:00:00Z')
const TO = new Date('2026-08-15T00:00:00Z')
const RANGE = { from: FROM, to: TO }

const row = (over: Partial<typeof usageRollups.$inferInsert>) => ({
  bucket: new Date('2026-08-14T13:00:00Z'),
  statusClass: 'success' as const,
  requests: 1, unpricedRequests: 0,
  promptTokens: 100, completionTokens: 50, cachedTokens: 0, reasoningTokens: 0,
  inputCostUsd: '0', cachedCostUsd: '0', outputCostUsd: '0', costUsd: '0.001000000',
  latencySumMs: 500, latencyMaxMs: 500, latencyCount: 1, ttftSumMs: 0, ttftCount: 0,
  ...over,
})

test('totals add up across buckets', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'gpt-5' }),
    row({ bucket: new Date('2026-08-14T14:00:00Z'), model: 'gpt-5', requests: 3 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(4)
  expect(totals.costUsd).toBe('0.002000000')
})

test('the error rate counts every non-success class', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 7 }),
    row({ model: 'b', statusClass: 'client_error', requests: 2 }),
    row({ model: 'c', statusClass: 'server_error', requests: 1 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(10)
  expect(totals.errorRequests).toBe(3)
})

test('average latency divides by its own count, not by requests', async () => {
  // ttft_count is 1 while requests is 2: a non-streaming request must not
  // halve the average TTFT.
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 2, latencySumMs: 1000, latencyCount: 2, ttftSumMs: 300, ttftCount: 1 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.avgLatencyMs).toBe(500)
  expect(totals.avgTtftMs).toBe(300)
})

test('an empty range reports zeroes and null averages', async () => {
  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(0)
  expect(totals.costUsd).toBe('0')
  // Null, not 0: nothing was measured. A 0 ms average would be a lie of the
  // same family as an unpriced request costing $0.
  expect(totals.avgLatencyMs).toBeNull()
})

test('unpriced requests survive into the totals', async () => {
  await db.insert(usageRollups).values([row({ model: 'a', requests: 2, unpricedRequests: 2, costUsd: '0' })])

  const totals = await loadTotals(RANGE)
  expect(totals.unpricedRequests).toBe(2)
})

test('filters narrow the totals', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  const [key] = await db
    .insert(apiKeys).values({ name: 'k', keyHash: 'h', keyPrefix: 'p', userId: user.id }).returning()

  await db.insert(usageRollups).values([
    row({ model: 'gpt-5', apiKeyId: key.id, userId: user.id }),
    row({ model: 'claude', requests: 5 }),
  ])

  expect((await loadTotals({ ...RANGE, model: 'gpt-5' })).requests).toBe(1)
  expect((await loadTotals({ ...RANGE, apiKeyId: key.id })).requests).toBe(1)
  expect((await loadTotals({ ...RANGE, userId: user.id })).requests).toBe(1)
})

test('the series splits requests by status class', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 4 }),
    row({ model: 'b', statusClass: 'server_error', requests: 1 }),
  ])

  const series = await loadSeries(RANGE, 'hour')
  expect(series).toHaveLength(1)
  expect(series[0].bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
  expect(series[0].success).toBe(4)
  expect(series[0].serverError).toBe(1)
  expect(series[0].clientError).toBe(0)
})

test('a daily grain collapses the hours of a day into one point', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', bucket: new Date('2026-08-14T01:00:00Z') }),
    row({ model: 'a', bucket: new Date('2026-08-14T23:00:00Z') }),
  ])

  const series = await loadSeries(RANGE, 'day')
  expect(series).toHaveLength(1)
  expect(series[0].bucket.toISOString()).toBe('2026-08-14T00:00:00.000Z')
  expect(series[0].success).toBe(2)
})

test('breakdown by model ranks by cost', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'cheap', costUsd: '0.000001000' }),
    row({ model: 'dear', costUsd: '9.000000000' }),
  ])

  const rows = await loadBreakdown(RANGE, 'model')
  expect(rows.map((r) => r.label)).toEqual(['dear', 'cheap'])
  expect(rows[0].costUsd).toBe('9.000000000')
})

test('breakdown by key labels a deleted key by its stored name', async () => {
  // No foreign key, so the row survives the key and still has a name to show.
  await db.insert(usageRollups).values([row({ model: 'a', apiKeyId: null, keyName: 'retired' })])

  const rows = await loadBreakdown(RANGE, 'key')
  expect(rows[0].label).toBe('retired')
})

test('breakdown labels a missing dimension rather than dropping the row', async () => {
  await db.insert(usageRollups).values([row({ model: null, provider: null })])

  expect((await loadBreakdown(RANGE, 'model'))[0].label).toBe('unknown')
  expect((await loadBreakdown(RANGE, 'provider'))[0].label).toBe('unknown')
})

test('loadRollupModels offers only models that have data', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'gpt-5' }),
    row({ model: 'gpt-5', bucket: new Date('2026-08-14T14:00:00Z') }),
    row({ model: 'openai/gpt-4.1' }),
  ])

  // Direct provider/model addresses too: /logs sources its dropdown from
  // virtual_models and cannot offer these at all.
  expect(await loadRollupModels()).toEqual(['gpt-5', 'openai/gpt-4.1'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/stats/query.test.ts
```

Expected: FAIL — cannot resolve `@/lib/stats/query`.

- [ ] **Step 3: Write the types**

Create `src/lib/stats/types.ts` with exactly the interfaces listed in the **Interfaces** block above, plus this comment on `costUsd`:

```ts
/** A string, never a number: numeric(18,9) exists so a sub-micro-dollar cost
 * does not round to zero, and parsing it into a float here would undo that
 * on the way to the page. */
```

- [ ] **Step 4: Write the implementation**

Create `src/lib/stats/query.ts`:

```ts
import 'server-only'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import type { Grain } from './buckets'
import type {
  BreakdownDimension, BreakdownRow, UsageFilter, UsagePoint, UsageTotals,
} from './types'

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0, errorRequests: 0, unpricedRequests: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  costUsd: '0', avgLatencyMs: null, maxLatencyMs: null, avgTtftMs: null,
}

function conditions(filter: UsageFilter) {
  const where = [gte(usageRollups.bucket, filter.from), lt(usageRollups.bucket, filter.to)]
  if (filter.apiKeyId) where.push(eq(usageRollups.apiKeyId, filter.apiKeyId))
  if (filter.userId) where.push(eq(usageRollups.userId, filter.userId))
  if (filter.model) where.push(eq(usageRollups.model, filter.model))
  return and(...where)
}

const int = (value: unknown): number => Number(value ?? 0)
/** Null rather than 0 when nothing was measured: a 0 ms average is the same
 * family of lie as an unpriced request costing $0. */
const avg = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

export async function loadTotals(filter: UsageFilter): Promise<UsageTotals> {
  const [row] = await db
    .select({
      requests: sql<string>`coalesce(sum(${usageRollups.requests}), 0)`,
      errorRequests: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} <> 'success'), 0)`,
      unpricedRequests: sql<string>`coalesce(sum(${usageRollups.unpricedRequests}), 0)`,
      promptTokens: sql<string>`coalesce(sum(${usageRollups.promptTokens}), 0)`,
      completionTokens: sql<string>`coalesce(sum(${usageRollups.completionTokens}), 0)`,
      cachedTokens: sql<string>`coalesce(sum(${usageRollups.cachedTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`,
      avgLatencyMs: sql<string | null>`sum(${usageRollups.latencySumMs})::numeric / nullif(sum(${usageRollups.latencyCount}), 0)`,
      maxLatencyMs: sql<string | null>`max(${usageRollups.latencyMaxMs})`,
      avgTtftMs: sql<string | null>`sum(${usageRollups.ttftSumMs})::numeric / nullif(sum(${usageRollups.ttftCount}), 0)`,
    })
    .from(usageRollups)
    .where(conditions(filter))

  if (!row) return EMPTY_TOTALS

  return {
    requests: int(row.requests),
    errorRequests: int(row.errorRequests),
    unpricedRequests: int(row.unpricedRequests),
    promptTokens: int(row.promptTokens),
    completionTokens: int(row.completionTokens),
    cachedTokens: int(row.cachedTokens),
    costUsd: String(row.costUsd ?? '0'),
    avgLatencyMs: avg(row.avgLatencyMs),
    maxLatencyMs: avg(row.maxLatencyMs),
    avgTtftMs: avg(row.avgTtftMs),
  }
}

export async function loadSeries(filter: UsageFilter, grain: Grain): Promise<UsagePoint[]> {
  // date_trunc with an explicit zone, for the same reason bucketExpr uses
  // one: without it the grouping would depend on the session's TimeZone.
  const bucket = sql<Date>`date_trunc(${grain}, ${usageRollups.bucket}, 'UTC')`

  const rows = await db
    .select({
      bucket,
      success: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'success'), 0)`,
      clientError: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'client_error'), 0)`,
      serverError: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'server_error'), 0)`,
      costUsd: sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`,
    })
    .from(usageRollups)
    .where(conditions(filter))
    .groupBy(bucket)
    .orderBy(bucket)

  return rows.map((r) => ({
    bucket: r.bucket,
    success: int(r.success),
    clientError: int(r.clientError),
    serverError: int(r.serverError),
    costUsd: String(r.costUsd ?? '0'),
  }))
}

const DIMENSIONS = {
  model: { id: usageRollups.model, label: usageRollups.model },
  key: { id: usageRollups.apiKeyId, label: usageRollups.keyName },
  user: { id: usageRollups.userId, label: usageRollups.userName },
  provider: { id: usageRollups.provider, label: usageRollups.provider },
} as const

export async function loadBreakdown(
  filter: UsageFilter,
  dimension: BreakdownDimension,
): Promise<BreakdownRow[]> {
  const { id, label } = DIMENSIONS[dimension]
  const cost = sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`

  const rows = await db
    .select({
      id: sql<string | null>`${id}::text`,
      // max(), not a group column: the label can vary within one id when a
      // key or user was renamed mid-range, and grouping by it would split one
      // entity into two rows.
      label: sql<string | null>`max(${label})`,
      requests: sql<string>`coalesce(sum(${usageRollups.requests}), 0)`,
      errorRequests: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} <> 'success'), 0)`,
      tokens: sql<string>`coalesce(sum(${usageRollups.promptTokens} + ${usageRollups.completionTokens}), 0)`,
      costUsd: cost,
    })
    .from(usageRollups)
    .where(conditions(filter))
    .groupBy(id)
    .orderBy(sql`${cost} DESC`)

  return rows.map((r) => ({
    id: r.id,
    // A row whose dimension is null is real usage that must still be shown —
    // dropping it would make the breakdown disagree with the totals.
    label: r.label ?? 'unknown',
    requests: int(r.requests),
    errorRequests: int(r.errorRequests),
    tokens: int(r.tokens),
    costUsd: String(r.costUsd ?? '0'),
  }))
}

/**
 * The models the filter bar can offer.
 *
 * From the rollup rather than from virtual_models, which is what /logs uses:
 * that misses direct `provider/model` addresses entirely. Reading it here is
 * cheap against a small table, and it can only ever offer values that have
 * data behind them.
 */
export async function loadRollupModels(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: usageRollups.model })
    .from(usageRollups)
    .orderBy(usageRollups.model)

  return rows.map((r) => r.model).filter((m): m is string => m !== null)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/stats/query.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/stats/types.ts src/lib/stats/query.ts tests/lib/stats/query.test.ts
git commit -m "feat(stats): dashboard read queries"
```

---

### Task 9: Search params and the page view

**Files:**
- Create: `src/lib/admin/dashboard-params.ts` (client-safe — no `server-only` import, no db)
- Create: `src/lib/admin/dashboard.ts` (server)
- Test: `tests/lib/admin/dashboard.test.ts`

**Interfaces:**
- Consumes: `grainFor` (Task 2), everything from Task 8.
- Produces (in `dashboard-params.ts`): `DEFAULT_DASHBOARD_RANGE = '7d'`, `DASHBOARD_RANGES`, `nextDashboardParams(current, name, value)`.
- Produces (in `dashboard.ts`):
  ```ts
  export interface DashboardSearchParams { range?: string; key?: string; user?: string; model?: string; from?: string; to?: string }
  export function parseDashboardFilter(params, now?): { filter: UsageFilter; range: string; grain: Grain; previous: UsageFilter | null }
  export interface DashboardView { totals; previous; series; breakdowns; models; keys; users; backfilledTo: Date | null; error: boolean }
  export function loadDashboard(parsed): Promise<DashboardView>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/admin/dashboard.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseDashboardFilter } from '@/lib/admin/dashboard'
import { nextDashboardParams } from '@/lib/admin/dashboard-params'

const NOW = new Date('2026-08-14T13:20:00Z')

test('no params means the default range', () => {
  const { filter, range, grain } = parseDashboardFilter({}, NOW)

  expect(range).toBe('7d')
  expect(filter.to.toISOString()).toBe(NOW.toISOString())
  expect(filter.from.toISOString()).toBe('2026-08-07T13:20:00.000Z')
  expect(grain).toBe('day')
})

test('a 24h range gets an hourly grain', () => {
  expect(parseDashboardFilter({ range: '24h' }, NOW).grain).toBe('hour')
})

test('an unrecognized range degrades to the default rather than throwing', () => {
  // A hand-edited URL should show the default view, not an error page — the
  // same contract parseLogFilter enforces.
  expect(parseDashboardFilter({ range: 'yesterday' }, NOW).range).toBe('7d')
})

test('a non-uuid key is dropped before it can reach a uuid column', () => {
  // eq(usageRollups.apiKeyId, 'nope') is "invalid input syntax for type uuid",
  // an unhandled Postgres error rather than an empty result.
  expect(parseDashboardFilter({ key: 'nope' }, NOW).filter.apiKeyId).toBeUndefined()
  expect(parseDashboardFilter({ user: 'nope' }, NOW).filter.userId).toBeUndefined()
})

test('a valid uuid key is kept', () => {
  const id = '0192f4a1-0000-7000-8000-000000000000'
  expect(parseDashboardFilter({ key: id }, NOW).filter.apiKeyId).toBe(id)
})

test('custom from/to override the range preset', () => {
  const { filter } = parseDashboardFilter({ range: '24h', from: '2026-08-01', to: '2026-08-03' }, NOW)

  expect(filter.from.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  // Inclusive of the whole end day: a user picking 1st to 3rd means through
  // the end of the 3rd, not up to its first instant.
  expect(filter.to.toISOString()).toBe('2026-08-04T00:00:00.000Z')
})

test('a malformed custom date falls back to the preset', () => {
  const { filter } = parseDashboardFilter({ range: '24h', from: 'not-a-date' }, NOW)
  expect(filter.from.toISOString()).toBe('2026-08-13T13:20:00.000Z')
})

test('an inverted custom range falls back rather than querying backwards', () => {
  const { filter } = parseDashboardFilter({ from: '2026-08-10', to: '2026-08-01' }, NOW)
  expect(filter.from.getTime()).toBeLessThan(filter.to.getTime())
})

test('the comparison period is the equal-length window before the range', () => {
  const { previous } = parseDashboardFilter({ range: '24h' }, NOW)

  expect(previous?.to.toISOString()).toBe('2026-08-13T13:20:00.000Z')
  expect(previous?.from.toISOString()).toBe('2026-08-12T13:20:00.000Z')
})

test('all-time has no comparison period', () => {
  // There is no "before all time"; a delta against it would be meaningless.
  expect(parseDashboardFilter({ range: 'all' }, NOW).previous).toBeNull()
})

test('filters carry into the comparison period', () => {
  const id = '0192f4a1-0000-7000-8000-000000000000'
  expect(parseDashboardFilter({ range: '24h', key: id }, NOW).previous?.apiKeyId).toBe(id)
})

test('nextDashboardParams deletes a filter set to its neutral value', () => {
  const current = new URLSearchParams('range=30d&model=gpt-5')

  expect(nextDashboardParams(current, 'model', 'all').toString()).toBe('range=30d')
  expect(nextDashboardParams(current, 'range', '7d').toString()).toBe('model=gpt-5')
})

test('nextDashboardParams clears custom dates when a preset is chosen', () => {
  // Leaving from/to behind would make the preset silently do nothing.
  const current = new URLSearchParams('from=2026-08-01&to=2026-08-03')

  expect(nextDashboardParams(current, 'range', '24h').toString()).toBe('range=24h')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/admin/dashboard.test.ts
```

Expected: FAIL — cannot resolve `@/lib/admin/dashboard`.

- [ ] **Step 3: Write `src/lib/admin/dashboard-params.ts`**

```ts
/**
 * Pure filter-URL helpers shared between the server-side parser
 * (`parseDashboardFilter` in `./dashboard`) and the client-side filter bar.
 *
 * Must stay free of the `server-only` boundary, for the same reason
 * `log-filter-params.ts` states: the filter bar is a Client Component, so
 * anything it imports lands in the browser bundle, and importing `./dashboard`
 * there would drag db and pg in with it and fail the build.
 */

export const DEFAULT_DASHBOARD_RANGE = '7d'

/** Milliseconds per preset. `null` means no lower bound at all. */
export const DASHBOARD_RANGES: Record<string, number | null> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  all: null,
}

const NEUTRAL_VALUES: Record<string, string> = {
  range: DEFAULT_DASHBOARD_RANGE,
  key: 'all',
  user: 'all',
  model: 'all',
}

/**
 * Applies one filter change: deletes the param when the value is that
 * filter's neutral one, sets it otherwise.
 *
 * Choosing a preset also clears `from`/`to`. A custom range wins over a
 * preset in `parseDashboardFilter`, so leaving the dates behind would make
 * the preset the user just clicked appear to do nothing.
 */
export function nextDashboardParams(
  current: URLSearchParams,
  name: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  if (!value || value === NEUTRAL_VALUES[name]) next.delete(name)
  else next.set(name, value)
  if (name === 'range') {
    next.delete('from')
    next.delete('to')
  }
  return next
}
```

- [ ] **Step 4: Write `src/lib/admin/dashboard.ts`**

```ts
import 'server-only'
import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users as usersTable } from '@/lib/db/schema'
import { listApiKeys } from '@/lib/admin/keys'
import { grainFor, type Grain } from '@/lib/stats/buckets'
import {
  EMPTY_TOTALS, loadBreakdown, loadRollupModels, loadSeries, loadTotals,
} from '@/lib/stats/query'
import { oldestLogHour, readRollupState } from '@/lib/stats/state'
import { resolveRequestLogStore } from '@/lib/logs'
import type {
  BreakdownDimension, BreakdownRow, UsageFilter, UsagePoint, UsageTotals,
} from '@/lib/stats/types'
import { DASHBOARD_RANGES, DEFAULT_DASHBOARD_RANGE } from './dashboard-params'

export { DASHBOARD_RANGES, DEFAULT_DASHBOARD_RANGE }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000

export interface DashboardSearchParams {
  range?: string
  key?: string
  user?: string
  model?: string
  from?: string
  to?: string
}

export interface ParsedDashboard {
  filter: UsageFilter
  /** The equal-length window before `filter`, or null when the range has no
   * meaningful "before" (all time). */
  previous: UsageFilter | null
  range: string
  grain: Grain
}

/** uuids reach a uuid column comparison; a malformed one is an unhandled
 * Postgres error rather than an empty result, so it is dropped here. */
function uuid(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined
}

/** A `YYYY-MM-DD` from a date input, read as UTC midnight. */
function day(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Turns URL search params into a filter.
 *
 * Every unrecognized value degrades to the default rather than throwing: a
 * hand-edited URL should show the default view, not an error page.
 */
export function parseDashboardFilter(
  params: DashboardSearchParams,
  now: Date = new Date(),
): ParsedDashboard {
  const range = params.range && params.range in DASHBOARD_RANGES
    ? params.range
    : DEFAULT_DASHBOARD_RANGE

  const custom = { from: day(params.from), to: day(params.to) }
  // The end day is inclusive: picking 1st to 3rd means through the end of the
  // 3rd, not up to its first instant.
  const customTo = custom.to ? new Date(custom.to.getTime() + DAY_MS) : null

  const window = DASHBOARD_RANGES[range]
  const useCustom = custom.from !== null && customTo !== null && custom.from < customTo

  const from = useCustom
    ? custom.from!
    : window === null ? new Date(0) : new Date(now.getTime() - window)
  const to = useCustom ? customTo! : now

  const dimensions = {
    ...(uuid(params.key) ? { apiKeyId: uuid(params.key) } : {}),
    ...(uuid(params.user) ? { userId: uuid(params.user) } : {}),
    ...(params.model?.trim() && params.model !== 'all' ? { model: params.model.trim() } : {}),
  }

  const filter: UsageFilter = { from, to, ...dimensions }

  // No "before all time", so no delta to show against it.
  const span = to.getTime() - from.getTime()
  const previous = !useCustom && window === null
    ? null
    : { from: new Date(from.getTime() - span), to: from, ...dimensions }

  return { filter, previous, range, grain: grainFor(from, to) }
}

export interface DashboardView {
  totals: UsageTotals
  previous: UsageTotals | null
  series: UsagePoint[]
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>
  models: string[]
  keys: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string }>
  /** The oldest hour the backfill has aggregated, when history is still
   * incomplete. Null once it has reached the oldest surviving log. */
  backfilledTo: Date | null
  /** The configured log store. Rollups are built from the Postgres store's
   * table, so anything else means this page has nothing to aggregate — an
   * explicit state, mirroring the "cannot be read back" panel on /logs. Only
   * `postgres` ships, but the registry exists for forks to add drivers. */
  storeName: string
  /** True when the read failed outright. Distinct from "no data": the page
   * renders its own banner rather than the generic Next error screen. */
  error: boolean
}

const NO_BREAKDOWNS = { model: [], key: [], user: [], provider: [] }

export async function loadDashboard(parsed: ParsedDashboard): Promise<DashboardView> {
  try {
    const [
      totals, previous, series, model, key, user, provider, models, keys, users, backfilledTo,
      store,
    ] = await Promise.all([
      loadTotals(parsed.filter),
      parsed.previous ? loadTotals(parsed.previous) : Promise.resolve(null),
      loadSeries(parsed.filter, parsed.grain),
      loadBreakdown(parsed.filter, 'model'),
      loadBreakdown(parsed.filter, 'key'),
      loadBreakdown(parsed.filter, 'user'),
      loadBreakdown(parsed.filter, 'provider'),
      loadRollupModels(),
      listApiKeys(),
      db.select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable).orderBy(asc(usersTable.name)),
      pendingBackfill(),
      resolveRequestLogStore(),
    ])

    return {
      totals, previous, series,
      breakdowns: { model, key, user, provider },
      models,
      keys: keys.map((k) => ({ id: k.id, name: k.name })),
      users,
      backfilledTo,
      storeName: store.store.name,
      error: false,
    }
  } catch (err) {
    console.error('[gateway] could not load the usage dashboard', err)
    return {
      totals: EMPTY_TOTALS, previous: null, series: [],
      breakdowns: NO_BREAKDOWNS, models: [], keys: [], users: [],
      backfilledTo: null, storeName: 'unknown', error: true,
    }
  }
}

/** The earliest aggregated hour while history is still being filled in, so a
 * total that is not yet complete never reads as one that is. */
async function pendingBackfill(): Promise<Date | null> {
  const now = new Date()
  const [state, oldest] = await Promise.all([readRollupState(now), oldestLogHour()])
  if (!state.backfilledTo || !oldest) return null
  return state.backfilledTo > oldest ? state.backfilledTo : null
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/admin/dashboard.test.ts
```

Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/admin/dashboard-params.ts src/lib/admin/dashboard.ts tests/lib/admin/dashboard.test.ts
git commit -m "feat(dashboard): filter parsing and view loading"
```

---

### Task 10: shadcn components and the filter bar

**Files:**
- Create: `src/components/ui/chart.tsx`, `src/components/ui/tabs.tsx`, `src/components/ui/card.tsx` (via CLI)
- Create: `src/app/(admin)/dashboard/dashboard-filters.tsx`
- Modify: `package.json`, `pnpm-lock.yaml` (recharts added by the CLI)

**Interfaces:**
- Consumes: `nextDashboardParams`, `DEFAULT_DASHBOARD_RANGE` (Task 9).
- Produces: `<DashboardFilters keys models users />` client component.

- [ ] **Step 1: Add the shadcn components**

```bash
pnpm dlx shadcn@latest add chart tabs card
```

Confirm `src/components/ui/chart.tsx`, `tabs.tsx` and `card.tsx` now exist and that `recharts` is in `package.json` dependencies.

- [ ] **Step 2: Write the filter bar**

Create `src/app/(admin)/dashboard/dashboard-filters.tsx`. It mirrors `src/app/(admin)/logs/log-filters.tsx` — read that file first and follow its Base UI `Select` idiom exactly, including the `if (v)` null guard on `onValueChange`.

```tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { DEFAULT_DASHBOARD_RANGE, nextDashboardParams } from '@/lib/admin/dashboard-params'

const RANGES = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

export function DashboardFilters({
  keys,
  users,
  models,
}: {
  keys: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string }>
  models: string[]
}) {
  const router = useRouter()
  const params = useSearchParams()

  function apply(name: string, value: string) {
    router.push(`/dashboard?${nextDashboardParams(params, name, value).toString()}`)
  }

  const custom = params.get('from') || params.get('to')

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        // A custom range is in force, so no preset is selected — showing one
        // would claim a window the page is not displaying.
        value={custom ? '' : params.get('range') ?? DEFAULT_DASHBOARD_RANGE}
        onValueChange={(v) => { if (v) apply('range', v) }}
      >
        <SelectTrigger className="w-40"><SelectValue placeholder="Custom range" /></SelectTrigger>
        <SelectContent>
          {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <Input
        type="date"
        aria-label="From date"
        className="w-40"
        value={params.get('from') ?? ''}
        onChange={(event) => apply('from', event.target.value)}
      />
      <Input
        type="date"
        aria-label="To date"
        className="w-40"
        value={params.get('to') ?? ''}
        onChange={(event) => apply('to', event.target.value)}
      />

      <Select value={params.get('key') ?? 'all'} onValueChange={(v) => { if (v) apply('key', v) }}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Any key" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any key</SelectItem>
          {keys.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('user') ?? 'all'} onValueChange={(v) => { if (v) apply('user', v) }}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Any user" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any user</SelectItem>
          {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('model') ?? 'all'} onValueChange={(v) => { if (v) apply('model', v) }}>
        <SelectTrigger className="w-52"><SelectValue placeholder="Any model" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any model</SelectItem>
          {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}
```

- [ ] **Step 3: Verify it compiles**

```bash
pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui package.json pnpm-lock.yaml "src/app/(admin)/dashboard/dashboard-filters.tsx"
git commit -m "feat(dashboard): filter bar and shadcn chart components"
```

---

### Task 11: The page and its stat tiles

**Files:**
- Create: `src/app/(admin)/dashboard/page.tsx`
- Create: `src/app/(admin)/dashboard/stat-tiles.tsx`
- Test: `tests/lib/admin/format.test.ts`
- Create: `src/lib/admin/format.ts`

**Interfaces:**
- Consumes: `loadDashboard`, `parseDashboardFilter` (Task 9), `DashboardFilters` (Task 10).
- Produces: `formatCost(value: string): string`, `formatCount(value: number): string`, `formatDelta(current: number, previous: number | null): string | null` in `src/lib/admin/format.ts`; `<StatTiles view />`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/admin/format.test.ts`:

```ts
import { expect, test } from 'vitest'
import { formatCost, formatCount, formatDelta } from '@/lib/admin/format'

test('cost keeps enough precision to show a small spend', () => {
  // The dashboard aggregates, so it does not need nine places the way a
  // single log row does — but it must not round a real spend to $0.00.
  expect(formatCost('12.345678900')).toBe('$12.3457')
  expect(formatCost('0.000012300')).toBe('$0.0000123')
  expect(formatCost('0')).toBe('$0')
})

test('counts get thousands separators', () => {
  expect(formatCount(1234567)).toBe('1,234,567')
})

test('a delta needs a previous period to compare against', () => {
  expect(formatDelta(120, 100)).toBe('+20%')
  expect(formatDelta(80, 100)).toBe('-20%')
  expect(formatDelta(100, 100)).toBe('0%')
  expect(formatDelta(100, null)).toBeNull()
})

test('growth from nothing is not a percentage', () => {
  // 100/0 is Infinity, and "+Infinity%" is not a number a person can read.
  expect(formatDelta(100, 0)).toBe('new')
  expect(formatDelta(0, 0)).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/admin/format.test.ts
```

Expected: FAIL — cannot resolve `@/lib/admin/format`.

- [ ] **Step 3: Write `src/lib/admin/format.ts`**

```ts
/** Display helpers for the dashboard. No `server-only`: the tiles render on
 * the server but the chart tooltip is a Client Component. */

/**
 * Costs arrive as numeric(18,9) strings.
 *
 * Four decimal places for anything a person would call money, and up to nine
 * for a total small enough that four would round it to $0.0000 — the same
 * refusal to show a lying zero that request_logs' scale-9 columns exist for.
 */
export function formatCost(value: string): string {
  const amount = Number(value)
  if (amount === 0) return '$0'
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(9).replace(/0+$/, '')}`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Change against the previous period, or null when there is nothing to
 * compare with.
 *
 * Growth from zero is reported as "new" rather than as a percentage: the
 * arithmetic is Infinity, and no reader is served by seeing it.
 */
export function formatDelta(current: number, previous: number | null): string | null {
  if (previous === null) return null
  if (previous === 0) return current === 0 ? null : 'new'

  const change = Math.round(((current - previous) / previous) * 100)
  return change > 0 ? `+${change}%` : `${change}%`
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test tests/lib/admin/format.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Write the stat tiles**

Create `src/app/(admin)/dashboard/stat-tiles.tsx`:

```tsx
import { Card, CardContent } from '@/components/ui/card'
import { formatCost, formatCount, formatDelta } from '@/lib/admin/format'
import type { UsageTotals } from '@/lib/stats/types'

function Tile({
  label, value, delta, note,
}: {
  label: string
  value: string
  delta?: string | null
  note?: string | null
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">
          {note ?? (delta ? `${delta} vs previous period` : ' ')}
        </div>
      </CardContent>
    </Card>
  )
}

export function StatTiles({
  totals,
  previous,
}: {
  totals: UsageTotals
  previous: UsageTotals | null
}) {
  const errorRate = totals.requests === 0
    ? null
    : `${((totals.errorRequests / totals.requests) * 100).toFixed(1)}%`

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Tile
        label="Requests"
        value={formatCount(totals.requests)}
        delta={formatDelta(totals.requests, previous?.requests ?? null)}
      />
      <Tile
        label="Cost"
        value={formatCost(totals.costUsd)}
        delta={formatDelta(Number(totals.costUsd), previous ? Number(previous.costUsd) : null)}
        // A total that excludes requests the catalog could not price is not
        // the whole story, and saying so is the entire reason the column
        // exists. The logs page makes the same refusal per row.
        note={totals.unpricedRequests > 0
          ? `${formatCount(totals.unpricedRequests)} unpriced`
          : null}
      />
      <Tile
        label="Tokens in / out"
        value={`${formatCount(totals.promptTokens)} / ${formatCount(totals.completionTokens)}`}
      />
      <Tile
        label="Error rate"
        value={errorRate ?? '—'}
        delta={previous && previous.requests > 0 && totals.requests > 0
          ? formatDelta(
              Math.round((totals.errorRequests / totals.requests) * 1000),
              Math.round((previous.errorRequests / previous.requests) * 1000),
            )
          : null}
      />
      <Tile
        label="Avg latency"
        value={totals.avgLatencyMs === null ? '—' : `${Math.round(totals.avgLatencyMs)} ms`}
        note={totals.avgTtftMs === null
          ? null
          : `${Math.round(totals.avgTtftMs)} ms to first token`}
      />
    </div>
  )
}
```

- [ ] **Step 6: Write the page**

Create `src/app/(admin)/dashboard/page.tsx`:

```tsx
import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'
import { requireAdmin } from '@/lib/admin/session'
import {
  loadDashboard, parseDashboardFilter, type DashboardSearchParams,
} from '@/lib/admin/dashboard'
import { DashboardFilters } from './dashboard-filters'
import { StatTiles } from './stat-tiles'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>
}) {
  await requireAdmin()
  const params = await searchParams
  const parsed = parseDashboardFilter(params)
  const view = await loadDashboard(parsed)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Usage, cost and errors, aggregated hourly from the request log."
      />

      {view.error ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
          <p className="font-medium">Usage statistics could not be read.</p>
          <p className="text-sm text-muted-foreground">
            Something went wrong reaching the database. This is usually transient —
            reload the page, or check the gateway&apos;s own server logs if it keeps
            happening.
          </p>
        </div>
      ) : view.storeName !== 'postgres' ? (
        <div className="space-y-2 rounded-md border px-4 py-8 text-center">
          <p className="font-medium">
            Usage statistics come from the{' '}
            <span className="font-mono">postgres</span> log store.
          </p>
          <p className="text-sm text-muted-foreground">
            Logging currently goes to <span className="font-mono">{view.storeName}</span>,
            which keeps no table for this page to aggregate. Requests are still being
            logged — there is just nothing here to count them from. Switch stores on the{' '}
            <Link className="underline" href="/settings">Settings</Link> page.
          </p>
        </div>
      ) : (
        <>
          {view.backfilledTo ? (
            <div className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
              Historical usage is still being aggregated. Totals are complete from{' '}
              <span className="font-mono">
                {view.backfilledTo.toISOString().slice(0, 16).replace('T', ' ')}
              </span>{' '}
              onward; earlier periods will fill in over the next few hours.
            </div>
          ) : null}

          <DashboardFilters keys={view.keys} users={view.users} models={view.models} />

          <StatTiles totals={view.totals} previous={view.previous} />

          {view.totals.requests === 0 ? (
            <div className="space-y-2 rounded-md border px-4 py-8 text-center">
              <p className="font-medium">No usage in this period.</p>
              <p className="text-sm text-muted-foreground">
                Requests are aggregated once a minute, so the most recent few may not
                be counted yet. Widen the range, or send a request and check{' '}
                <Link className="underline" href="/logs">Request logs</Link>.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add src/lib/admin/format.ts tests/lib/admin/format.test.ts "src/app/(admin)/dashboard"
git commit -m "feat(dashboard): page shell and stat tiles"
```

---

### Task 12: The charts

**Files:**
- Create: `src/app/(admin)/dashboard/usage-charts.tsx`
- Modify: `src/app/(admin)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `UsagePoint[]` (Task 8), `Grain` (Task 2), `src/components/ui/chart.tsx` (Task 10).
- Produces: `<UsageCharts series grain />`.

- [ ] **Step 1: Load the dataviz skill**

Before writing any chart code, invoke the `dataviz` skill. It governs palette, axis, legend and tooltip choices, and the two charts here must read as one system with the rest of the admin UI.

- [ ] **Step 2: Write the charts**

Create `src/app/(admin)/dashboard/usage-charts.tsx`:

```tsx
'use client'

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { formatCost, formatCount } from '@/lib/admin/format'
import type { Grain } from '@/lib/stats/buckets'
import type { UsagePoint } from '@/lib/stats/types'

/** Errors sit on top of the healthy mass, so the bottom of each bar is the
 * traffic that worked and the cap is what did not. */
const REQUEST_CONFIG = {
  success: { label: 'Success', color: 'var(--chart-1)' },
  clientError: { label: 'Client error', color: 'var(--chart-4)' },
  serverError: { label: 'Server error', color: 'var(--chart-5)' },
} satisfies ChartConfig

const COST_CONFIG = {
  cost: { label: 'Cost', color: 'var(--chart-2)' },
} satisfies ChartConfig

function tickFormatter(grain: Grain) {
  return (value: string) => {
    const date = new Date(value)
    if (grain === 'hour') {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
      })
    }
    if (grain === 'day') {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
}

export function UsageCharts({ series, grain }: { series: UsagePoint[]; grain: Grain }) {
  // The page's own empty state covers this; two blank axes would say less.
  if (series.length === 0) return null

  const data = series.map((point) => ({
    bucket: point.bucket.toISOString(),
    success: point.success,
    clientError: point.clientError,
    serverError: point.serverError,
    // Strings everywhere else on purpose — numeric(18,9) must not be parsed
    // into a float on the way through the database layer. A chart cannot
    // plot a string, so the conversion happens here and nowhere earlier.
    cost: Number(point.costUsd),
  }))

  const formatTick = tickFormatter(grain)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-sm font-medium">Requests</div>
          {/* Its own scroll container: a wide series must never make the page
              body scroll sideways. */}
          <div className="overflow-x-auto">
            <ChartContainer config={REQUEST_CONFIG} className="h-64 w-full min-w-80">
              <BarChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8}
                  minTickGap={24} tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false} axisLine={false} width={48}
                  tickFormatter={(v: number) => formatCount(v)}
                />
                <ChartTooltip
                  content={<ChartTooltipContent labelFormatter={(_, p) =>
                    formatTick(String(p[0]?.payload?.bucket))} />}
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="success" stackId="r" fill="var(--color-success)" />
                <Bar dataKey="clientError" stackId="r" fill="var(--color-clientError)" />
                <Bar dataKey="serverError" stackId="r" fill="var(--color-serverError)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-sm font-medium">Cost</div>
          <div className="overflow-x-auto">
            <ChartContainer config={COST_CONFIG} className="h-64 w-full min-w-80">
              <AreaChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8}
                  minTickGap={24} tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false} axisLine={false} width={64}
                  // The same formatter the tiles use, so the axis and the
                  // headline number cannot disagree about what a cost is.
                  tickFormatter={(v: number) => formatCost(String(v))}
                />
                <ChartTooltip
                  content={<ChartTooltipContent
                    labelFormatter={(_, p) => formatTick(String(p[0]?.payload?.bucket))}
                    formatter={(value) => formatCost(String(value))}
                  />}
                />
                <Area
                  dataKey="cost" type="monotone" stroke="var(--color-cost)"
                  fill="var(--color-cost)" fillOpacity={0.2}
                />
              </AreaChart>
            </ChartContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```

Two things to check against the shadcn `chart.tsx` the CLI actually generated, since its API has moved between versions: that `ChartLegendContent` is exported under that name, and that `ChartTooltipContent` accepts `labelFormatter` and `formatter`. Adjust the call sites to match the generated file rather than the other way round. The `--color-<key>` variables are defined by `ChartContainer` from the config, so both themes work with no second palette.

- [ ] **Step 3: Render them on the page**

In `src/app/(admin)/dashboard/page.tsx`, import `UsageCharts` and render it after `<StatTiles />`, turning the existing empty-state block into the other half of one ternary so a period with no traffic shows the message instead of two blank axes:

```tsx
{view.totals.requests === 0 ? (
  <div className="space-y-2 rounded-md border px-4 py-8 text-center">
    {/* unchanged empty state from Task 11 */}
  </div>
) : (
  <UsageCharts series={view.series} grain={parsed.grain} />
)}
```

- [ ] **Step 4: Check it in a browser**

```bash
pnpm test:db:up
pnpm dev:test-db
```

Port **3001**, against the throwaway `babellm_dev` database on 5434. Never `pnpm dev` — that reads `.env` and drives the developer's own database on 5432.

Seed some traffic, wait one tick (60s) or call `runUsageRollup()` directly, then open `http://localhost:3001/dashboard` and confirm: both charts render, the tooltip shows formatted costs, the legend names the three status classes, and the page does not scroll horizontally at a narrow window width.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint
git add "src/app/(admin)/dashboard"
git commit -m "feat(dashboard): request and cost charts"
```

---

### Task 13: Breakdown tables

**Files:**
- Create: `src/app/(admin)/dashboard/breakdowns.tsx`
- Modify: `src/app/(admin)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `BreakdownRow` (Task 8), `Tabs` (Task 10), `formatCost` / `formatCount` (Task 11).
- Produces: `<Breakdowns breakdowns logsHref />`.

- [ ] **Step 1: Write the component**

Create `src/app/(admin)/dashboard/breakdowns.tsx`:

```tsx
'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { formatCost, formatCount } from '@/lib/admin/format'
import type { BreakdownDimension, BreakdownRow } from '@/lib/stats/types'

const TABS: Array<{ value: BreakdownDimension; label: string }> = [
  { value: 'model', label: 'By model' },
  { value: 'key', label: 'By key' },
  { value: 'user', label: 'By user' },
  { value: 'provider', label: 'By provider' },
]

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Errors</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.id ?? 'none'}-${row.label}`}>
            <TableCell className="font-mono text-xs">{row.label}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(row.requests)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {row.errorRequests === 0 ? '—' : formatCount(row.errorRequests)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {formatCount(row.tokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatCost(row.costUsd)}</TableCell>
          </TableRow>
        ))}
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
              Nothing in this period.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

export function Breakdowns({
  breakdowns,
}: {
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>
}) {
  return (
    <Tabs defaultValue="model">
      <TabsList>
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          <BreakdownTable rows={breakdowns[tab.value]} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
```

- [ ] **Step 2: Add the deep link to /logs**

In `src/app/(admin)/dashboard/page.tsx`, build a `/logs` href carrying the equivalent filters and render it as the `PageHeader`'s `action`:

```tsx
function logsHref(params: DashboardSearchParams): string {
  const next = new URLSearchParams()
  // /logs has no user filter and its own range vocabulary; only what both
  // pages agree on carries over. A filter that silently changed meaning
  // across the link would be worse than one that does not travel.
  if (params.key) next.set('key', params.key)
  if (params.model) next.set('model', params.model)
  if (params.range && ['24h', '7d', '30d'].includes(params.range)) {
    next.set('range', params.range)
  }
  const query = next.toString()
  return query ? `/logs?${query}` : '/logs'
}
```

```tsx
<PageHeader
  title="Dashboard"
  description="Usage, cost and errors, aggregated hourly from the request log."
  action={
    <Button variant="secondary" nativeButton={false} render={<Link href={logsHref(params)} />}>
      View these requests
    </Button>
  }
/>
```

Add `Button` to the page's imports (`@/components/ui/button`), and render `<Breakdowns breakdowns={view.breakdowns} />` directly after `<UsageCharts />`, inside the same non-empty branch of the ternary.

- [ ] **Step 3: Verify in the browser**

```bash
pnpm dev:test-db
```

At `http://localhost:3001/dashboard`: all four tabs render, costs match the tiles, and "View these requests" lands on `/logs` with the key and model filters preserved.

- [ ] **Step 4: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add "src/app/(admin)/dashboard"
git commit -m "feat(dashboard): breakdown tables and a link through to the logs"
```

---

### Task 14: Navigation, landing page and docs

**Files:**
- Modify: `src/app/(admin)/layout.tsx:19-31`
- Modify: `src/app/page.tsx`
- Modify: `README.md`

- [ ] **Step 1: Add the nav entry**

In `src/app/(admin)/layout.tsx`, add a new first section above the existing unlabeled group:

```ts
const NAV: NavSection[] = [
  {
    items: [{ href: '/dashboard', label: 'Dashboard' }],
  },
  {
    items: [
      { href: '/providers', label: 'Providers' },
      ...
```

- [ ] **Step 2: Change the landing page**

In `src/app/page.tsx`:

```ts
import { redirect } from 'next/navigation'

export default function Home() {
  // The first thing after login should be what the gateway is doing, not how
  // it is configured.
  redirect('/dashboard')
}
```

- [ ] **Step 3: Document it in the README**

Add a Dashboard section covering: what the page shows; that it reads an hourly rollup rather than `request_logs`, so it stays fast as the log table grows; that figures for the last two hours may still be settling as late-finishing requests land; and — the operationally important one — that **usage history outlives the log retention window**, so `/dashboard` can answer questions about periods `/logs` no longer holds.

- [ ] **Step 4: Full verification**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: everything passes, including the 874 pre-existing tests.

Then, in a browser on port **3001** (`pnpm dev:test-db`): logging in lands on `/dashboard`, the nav highlights it, and every other page still works.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/layout.tsx" src/app/page.tsx README.md
git commit -m "feat(dashboard): make it the landing page"
```

---

## Verification before completion

Invoke `superpowers:verification-before-completion`. Do not claim this is done without pasting real output for:

1. `pnpm test` — full suite, showing the new test count.
2. `pnpm typecheck && pnpm lint`.
3. A browser check on port 3001 confirming the dashboard renders with real aggregated data.

Then invoke `superpowers:finishing-a-development-branch`. Per AGENTS.md, merging this worktree into `main` is a **squash merge** — `git merge --squash worktree-usage-dashboard`, one commit describing the whole change — then delete the branch and remove the worktree.
