# Request Log Partitioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition `request_logs` by calendar month on its uuid v7 primary key, fold `request_payloads` into the row, delete `request_id` in favour of the v7 id, and replace hourly row-deletion retention with a boot-plus-daily partition maintenance job.

**Architecture:** Postgres compares `uuid` byte-wise and v7 leads with a big-endian millisecond timestamp, so uuid order is time order and `uuidv7Bound(monthStart)` is a partition boundary. `PARTITION BY RANGE (id)` keeps the primary key a bare `(id)` — a partitioned table requires the partition key in every unique constraint, which is why `request_id` cannot keep a unique index and is removed instead. Retention becomes `DROP TABLE` on whole months. A maintenance job provisions three months ahead under an advisory lock so no write ever finds a missing partition; there is no `DEFAULT` partition.

**Tech Stack:** Next.js (App Router), TypeScript, Drizzle ORM, `pg`, Postgres 17, Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-13-request-logs-design.md`

## Global Constraints

- **Branch:** `worktree-request-logs`. Do not commit to `main`. The feature this revises is not on `main` and has never been deployed.
- **Nothing has shipped.** Migration `0003` is rewritten in place rather than superseded. There is no data migration, no backfill, and no compatibility shim.
- **Tests and browser checks run against the disposable Postgres on port 5434 only.** Never 5432 — that is the developer's own database. `.env.test` already points at 5434; do not repoint it.
- **Months are UTC.** Never the server's local zone.
- `DEFAULT_RETENTION_MONTHS = 3`. `retentionMonths: N` keeps the current month and the `N - 1` preceding it; `0` keeps everything.
- `MONTHS_AHEAD = 3` — `ensurePartitions` creates the current month plus the next three, four partitions in all.
- **No `DEFAULT` partition**, ever. It strands rows outside retention and blocks creating the month it swallowed.
- Partition names are exactly `request_logs_YYYY_MM` (zero-padded month).
- Baseline before any change: `pnpm test` is green at **60 files, 642 tests**. Every task must leave it green.
- Follow the existing comment style: comments explain *why*, never *what*.

---

## File Structure

**Created**
- `src/lib/logs/partitions.ts` — UTC month arithmetic, partition naming, `ensurePartitions`, `dropExpiredPartitions`. No advisory lock, no settings, no timers. Pure SQL over a `Queryable`.
- `tests/lib/logs/partitions.test.ts` — unit tests for the arithmetic, integration tests for create/drop against real Postgres.

**Renamed**
- `src/lib/logs/retention.ts` → `src/lib/logs/maintenance.ts` — the job: advisory lock, settings resolution, driver loop, `logs.last_maintenance`, the boot-and-daily timer.
- `tests/lib/logs/retention.test.ts` → `tests/lib/logs/maintenance.test.ts`

**Deleted**
- `request_payloads` table, its Drizzle model, and its `RequestPayloadRow` type.

**Modified**
- `src/lib/db/schema.ts` — `requestLogs` loses `requestId`, gains three payload columns; `requestPayloads` removed.
- `drizzle/0003_*.sql` + `drizzle/meta/` — regenerated, then hand-edited to add `PARTITION BY RANGE`.
- `src/lib/logs/types.ts` — `RequestLogEntry.id`, `MaintenanceResult`, `maintain()` replaces `prune()`, `get(id)`, `LogRow.id` without `requestId`.
- `src/lib/logs/postgres.ts` — single-row write, `get` by id with uuid validation, `maintain` replacing `prune`.
- `src/lib/logs/stdout.ts`, `src/lib/logs/line.ts` — `entry.id` replaces `entry.requestId`.
- `src/lib/settings.ts` — `retentionMonths` replaces `retentionDays`.
- `src/lib/gateway/chat-handler.ts` — id minted at request start with `uuidv7()`.
- `src/instrumentation.ts` — awaited boot run plus a 24 h timer.
- `src/app/(admin)/logs/[requestId]/` → `[id]/`, `src/app/(admin)/logs/page.tsx`, `log-filters.tsx`, `src/app/(admin)/settings/{page,actions,governance-form}.tsx`.
- `tests/helpers/db.ts` — drop `request_payloads` from `TRUNCATE`, provision partitions after truncating.

---

## Task Ordering

Tasks 1–3 are the foundation: schema, migration, partition module. Task 4 makes the test harness able to run at all against a partitioned table with no `DEFAULT`. Tasks 5–8 move the application code over. Tasks 9–11 are the maintenance job, the UI, and the docs.

**After Task 2 the suite will not be green until Task 8.** This is unavoidable — `request_id` is load-bearing in nine files. Tasks 3–7 each commit with a known, named set of failures; Task 8 closes them. Each of those tasks states exactly which failures are expected so a reviewer can tell a planned failure from a new one.

---

### Task 1: Rewrite the schema model

**Files:**
- Modify: `src/lib/db/schema.ts:190-270` (`requestLogs` at 190, `requestPayloads` at 250, `RequestPayloadRow` at 269)

**Interfaces:**
- Consumes: nothing.
- Produces: `requestLogs` with columns `id, createdAt, apiKeyId, keyName, model, stream, status, outcome, errorType, errorCode, errorMessage, latencyMs, ttftMs, attempts, finalTargetId, finalProviderId, finalProvider, finalUpstreamModel, promptTokens, completionTokens, cachedTokens, reasoningTokens, inputCostUsd, cachedCostUsd, outputCostUsd, costUsd, pricing, droppedParams, payloadCaptured, requestJson, responseJson, payloadTruncated`. Type `RequestLogRow`. `requestPayloads` and `RequestPayloadRow` no longer exist.

- [ ] **Step 1: Remove `requestId` and add the payload columns**

In `src/lib/db/schema.ts`, inside `requestLogs`, delete the `requestId` line and replace the id comment:

```ts
export const requestLogs = pgTable(
  'request_logs',
  {
    // v7, minted at request start rather than defaulted at insert: the same
    // value is the client's x-request-id, the stdout correlation id, and the
    // partition key. A column default would mint it too late to be any of
    // those. Ordering by it is therefore by request start, while created_at
    // records completion.
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

Note `.primaryKey()` with no `$defaultFn` — the caller supplies the id now. Remove the `uuidv7` import from this file; it is no longer used here.

- [ ] **Step 2: Add the payload columns to `requestLogs`**

Replace the trailing `payloadCaptured` line with:

```ts
    droppedParams: jsonb('dropped_params').$type<string[]>(),
    payloadCaptured: boolean('payload_captured').notNull().default(false),

    // Inline rather than a second table. A separate payloads table needs a
    // foreign key pointing *at* request_logs, and an inbound foreign key makes
    // a partition undroppable — which would defeat partitioning entirely.
    // Postgres gives each partition its own TOAST relation, so a large body is
    // already stored out of line and is only read when the column is selected.
    requestJson: jsonb('request_json').$type<unknown>(),
    responseJson: jsonb('response_json').$type<unknown>(),
    payloadTruncated: boolean('payload_truncated').notNull().default(false),
  },
  (table) => [
    index('request_logs_api_key_idx').on(table.apiKeyId, table.id.desc()),
    index('request_logs_model_idx').on(table.model, table.id.desc()),
  ],
)
```

The `uniqueIndex('request_logs_request_id_idx')` line is gone. Postgres requires every unique constraint on a partitioned table to contain the partition key, so a global unique index on anything but `id` is not expressible.

- [ ] **Step 3: Delete the `requestPayloads` table and its type**

Delete the whole `export const requestPayloads = pgTable('request_payloads', {...})` block and the `export type RequestPayloadRow = typeof requestPayloads.$inferSelect` line.

- [ ] **Step 4: Check that `uniqueIndex` is still used elsewhere in the file**

Run: `grep -n "uniqueIndex" src/lib/db/schema.ts`
Expected: still used by `api_keys` and `catalog_models`, so the import stays. If the grep returns only the import line, remove it from the import list.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL, with errors only in files that reference `requestPayloads` or `requestId` — `src/lib/logs/postgres.ts`, `tests/lib/db/request-logs-schema.test.ts`, `tests/lib/logs/postgres-store.test.ts`, `tests/helpers/db.ts`. Those are closed by Tasks 5 and 8. Any error in another file means something above was mistyped.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts
git commit -m "refactor(schema): fold payloads into request_logs, drop request_id"
```

---

### Task 2: Regenerate migration 0003 as a partitioned table

**Files:**
- Delete: `drizzle/0003_black_susan_delgado.sql`, `drizzle/meta/0003_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/0003_<generated-name>.sql` (drizzle-kit picks the name)

**Interfaces:**
- Consumes: the `requestLogs` model from Task 1.
- Produces: a `request_logs` table declared `PARTITION BY RANGE ("id")` with no partitions and no `DEFAULT`.

- [ ] **Step 1: Remove the old migration and its snapshot**

```bash
rm drizzle/0003_black_susan_delgado.sql drizzle/meta/0003_snapshot.json
```

Then edit `drizzle/meta/_journal.json` and delete the entry with `"idx": 3` (the `0003_black_susan_delgado` object), including the comma that precedes it. The `entries` array must end at `idx: 2`.

Rewriting rather than adding a migration is correct here only because nothing has shipped. Drizzle's migrator decides what to apply from the journal's `when` timestamps, not from file content — an edited-in-place migration is silently skipped on any database that already ran it. That is exactly why Step 5 recreates the test database instead of migrating it.

- [ ] **Step 2: Generate the replacement**

Run: `pnpm db:generate`
Expected: writes a new `drizzle/0003_<name>.sql` and `drizzle/meta/0003_snapshot.json`, and appends an `idx: 3` journal entry. The SQL should contain `CREATE TYPE "public"."request_outcome"`, `CREATE TABLE "request_logs"`, the two `CREATE INDEX` statements, and the `api_keys` foreign key — and **no** `request_payloads` and **no** unique index on `request_id`.

- [ ] **Step 3: Verify what was generated before editing it**

Run: `grep -n "request_payloads\|request_id\|PARTITION" drizzle/0003_*.sql`
Expected: no output at all. If `request_payloads` or `request_id` appears, Task 1 was incomplete — fix it and regenerate rather than hand-patching here.

- [ ] **Step 4: Hand-edit the generated SQL to partition the table**

`drizzle-kit` cannot express `PARTITION BY`, so this one clause is added by hand. Find the `CREATE TABLE "request_logs" (...)` statement and append the clause to it, converting the terminating `);` into `) PARTITION BY RANGE ("id");`. Add the comment above the statement:

```sql
-- Partitioned by month on the v7 primary key. Postgres compares uuid
-- byte-wise and v7 leads with a big-endian millisecond timestamp, so uuid
-- order is time order and a month boundary is a plain uuid bound.
-- Partitioning on id rather than created_at is what keeps the primary key a
-- bare (id): a partitioned table requires the partition key in every unique
-- constraint.
--
-- No partitions are created here and there is deliberately no DEFAULT
-- partition. src/lib/logs/partitions.ts owns the month arithmetic, so it has
-- exactly one implementation and it is not duplicated in SQL.
CREATE TABLE "request_logs" (
	...
) PARTITION BY RANGE ("id");
```

Leave every other statement byte-for-byte as generated.

- [ ] **Step 5: Recreate the test database and apply the migration**

The test database already has the old `0003` recorded as applied, so it will never pick up the rewrite. Drop it; `tests/setup/global-setup.ts` recreates and migrates it on the next run.

```bash
docker exec babellm-test-postgres-test-1 \
  psql -U babellm -d postgres -c 'DROP DATABASE IF EXISTS babellm_test'
```

Expected: `DROP DATABASE`. If it reports the database is being accessed by other users, stop any running `vitest` and retry.

- [ ] **Step 6: Prove the table is partitioned and has no partitions yet**

```bash
pnpm vitest run tests/lib/uuid.test.ts
docker exec babellm-test-postgres-test-1 psql -U babellm -d babellm_test -c \
  "SELECT relkind FROM pg_class WHERE relname = 'request_logs'" -c \
  "SELECT count(*) AS partitions FROM pg_inherits i
     JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'request_logs'" -c \
  "SELECT to_regclass('request_payloads') AS payloads_table"
```

Expected: the uuid test passes (it is the cheapest way to make global-setup run the migration); `relkind` is `p` (partitioned table, not `r`); `partitions` is `0`; `payloads_table` is empty.

- [ ] **Step 7: Commit**

```bash
git add drizzle/
git commit -m "feat(db): declare request_logs PARTITION BY RANGE on the v7 id"
```

---

### Task 3: The partitions module

**Files:**
- Create: `src/lib/logs/partitions.ts`
- Test: `tests/lib/logs/partitions.test.ts`

**Interfaces:**
- Consumes: `uuidv7Bound` from `@/lib/uuid`.
- Produces:
  - `MONTHS_AHEAD: number` (3)
  - `monthStart(date: Date): Date` — first instant of that UTC month
  - `partitionName(date: Date): string` — `request_logs_YYYY_MM`
  - `monthBound(date: Date): string` — the uuid at `monthStart(date)`
  - `addMonths(date: Date, count: number): Date`
  - `Queryable` — `{ query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> }`
  - `ensurePartitions(client: Queryable, now: Date): Promise<string[]>` — names created (already-present months are not listed)
  - `dropExpiredPartitions(client: Queryable, now: Date, retentionMonths: number): Promise<string[]>` — names dropped

- [ ] **Step 0: Stop `resetDb` truncating a table that no longer exists**

This task's tests call `resetDb`, which still names `request_payloads` in its `TRUNCATE` list — a table Tasks 1–2 deleted. Every test here would fail on a missing relation before reaching what it asserts. Task 4 fixes `resetDb` properly, but it cannot run first: it imports `ensurePartitions` from this task.

In `tests/helpers/db.ts`, delete `'request_payloads', ` from the `TABLES` array, leaving `'request_logs',` as the first entry. Change nothing else in that file — the partition provisioning is Task 4's.

```ts
const TABLES = [
  'request_logs',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]
```

- [ ] **Step 1: Write the failing unit tests for the arithmetic**

Create `tests/lib/logs/partitions.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { pool } from '@/lib/db'
import { uuidv7Bound } from '@/lib/uuid'
import {
  addMonths, dropExpiredPartitions, ensurePartitions, monthBound, monthStart, partitionName,
} from '@/lib/logs/partitions'
import { resetDb } from '../../helpers/db'

const utc = (iso: string) => new Date(iso)

test('monthStart truncates to the first instant of the UTC month', () => {
  expect(monthStart(utc('2026-08-13T21:47:03.123Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('monthStart uses UTC, not the local zone', () => {
  // 23:30 on 31 July in UTC is already August in any zone east of Greenwich.
  // Reading the local month here would file the row a month early on half the
  // planet's servers and leave the two halves disagreeing about which
  // partition a row belongs to.
  expect(monthStart(utc('2026-07-31T23:30:00Z')).toISOString())
    .toBe('2026-07-01T00:00:00.000Z')
})

test('addMonths rolls the year over in both directions', () => {
  expect(addMonths(utc('2026-12-01T00:00:00Z'), 1).toISOString())
    .toBe('2027-01-01T00:00:00.000Z')
  expect(addMonths(utc('2026-01-01T00:00:00Z'), -1).toISOString())
    .toBe('2025-12-01T00:00:00.000Z')
})

test('addMonths does not overflow from a long month into the wrong one', () => {
  // Date.setMonth on 31 January + 1 month yields 3 March, because 31 February
  // does not exist. Partition bounds are always month starts, but the helper
  // must not be a trap for a caller that passes anything else.
  expect(addMonths(utc('2026-01-31T00:00:00Z'), 1).toISOString())
    .toBe('2026-02-01T00:00:00.000Z')
})

test('partitionName zero-pads the month', () => {
  expect(partitionName(utc('2026-08-13T00:00:00Z'))).toBe('request_logs_2026_08')
  expect(partitionName(utc('2026-11-02T00:00:00Z'))).toBe('request_logs_2026_11')
})

test('monthBound agrees with uuidv7Bound at the month start', () => {
  expect(monthBound(utc('2026-08-13T09:00:00Z')))
    .toBe(uuidv7Bound(utc('2026-08-01T00:00:00Z')))
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/lib/logs/partitions.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/logs/partitions"`.

- [ ] **Step 3: Write the arithmetic**

Create `src/lib/logs/partitions.ts`:

```ts
import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'

/** Months provisioned beyond the current one. There is no DEFAULT partition
 * to catch a write for an unprovisioned month, so this lead time is the only
 * thing standing between a broken maintenance job and lost log lines: the job
 * must fail continuously for a full quarter, through every boot and every
 * daily tick, before a write can find no home. */
export const MONTHS_AHEAD = 3

const PARTITION_RE = /^request_logs_(\d{4})_(\d{2})$/

export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** The first instant of `date`'s month, in UTC. Never the local zone: a
 * partition boundary that moved with a deployment's timezone would put the
 * same row in different months on different instances. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

/** Month arithmetic on the truncated month, so a caller passing the 31st
 * cannot land two months out — Date.UTC(2026, 1, 31) is 3 March. */
export function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
}

export function partitionName(date: Date): string {
  const start = monthStart(date)
  const month = String(start.getUTCMonth() + 1).padStart(2, '0')
  return `request_logs_${start.getUTCFullYear()}_${month}`
}

/** The lowest uuid that can be written in `date`'s month — the partition's
 * lower bound, and the next month's exclusive upper bound. */
export function monthBound(date: Date): string {
  return uuidv7Bound(monthStart(date))
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm vitest run tests/lib/logs/partitions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing integration tests for create and drop**

Append to `tests/lib/logs/partitions.test.ts`:

```ts
async function partitions(): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs'
    ORDER BY c.relname
  `)
  return rows.map((row) => String(row.name))
}

test('ensurePartitions creates the current month and three ahead', async () => {
  await ensurePartitions(pool, utc('2030-03-15T00:00:00Z'))

  expect(await partitions()).toEqual(expect.arrayContaining([
    'request_logs_2030_03', 'request_logs_2030_04',
    'request_logs_2030_05', 'request_logs_2030_06',
  ]))
})

test('ensurePartitions is idempotent and reports only what it created', async () => {
  const first = await ensurePartitions(pool, utc('2031-11-02T00:00:00Z'))
  expect(first).toHaveLength(4)
  // Crosses a year boundary: November plus three is February of the next year.
  expect(first).toContain('request_logs_2032_02')

  const second = await ensurePartitions(pool, utc('2031-11-02T00:00:00Z'))
  expect(second).toEqual([])
})

test('a row routes to the partition its id encodes', async () => {
  await ensurePartitions(pool, utc('2030-03-15T00:00:00Z'))
  const id = monthBound(utc('2030-04-09T00:00:00Z'))

  await pool.query(`
    INSERT INTO request_logs (id, status, outcome, latency_ms)
    VALUES ('${id}', 200, 'ok', 1)
  `)
  const { rows } = await pool.query(
    `SELECT tableoid::regclass::text AS partition FROM request_logs WHERE id = '${id}'`,
  )
  expect(rows[0].partition).toBe('request_logs_2030_04')
})

test('a write with no partition for its month fails rather than going anywhere else', async () => {
  // The cost of having no DEFAULT partition, asserted rather than assumed:
  // the failure is loud and local, not a row quietly parked outside retention.
  const id = monthBound(utc('2040-01-05T00:00:00Z'))
  await expect(pool.query(`
    INSERT INTO request_logs (id, status, outcome, latency_ms)
    VALUES ('${id}', 200, 'ok', 1)
  `)).rejects.toThrow(/no partition of relation/i)
})

test('dropExpiredPartitions keeps the current month and N-1 before it', async () => {
  const now = utc('2030-06-15T00:00:00Z')
  await ensurePartitions(pool, utc('2030-01-15T00:00:00Z'))
  await ensurePartitions(pool, now)

  const dropped = await dropExpiredPartitions(pool, now, 3)

  expect(dropped).toEqual([
    'request_logs_2030_01', 'request_logs_2030_02', 'request_logs_2030_03',
  ])
  const left = await partitions()
  expect(left).toContain('request_logs_2030_04')
  expect(left).toContain('request_logs_2030_06')
  expect(left).not.toContain('request_logs_2030_03')
})

test('dropExpiredPartitions never drops a future partition', async () => {
  const now = utc('2030-06-15T00:00:00Z')
  await ensurePartitions(pool, now)

  await dropExpiredPartitions(pool, now, 1)

  expect(await partitions()).toEqual(expect.arrayContaining([
    'request_logs_2030_06', 'request_logs_2030_07',
    'request_logs_2030_08', 'request_logs_2030_09',
  ]))
})

test('zero retention drops nothing', async () => {
  await ensurePartitions(pool, utc('2029-01-15T00:00:00Z'))
  expect(await dropExpiredPartitions(pool, utc('2030-06-15T00:00:00Z'), 0)).toEqual([])
  expect(await partitions()).toContain('request_logs_2029_01')
})

test('a partition whose name does not parse is left alone', async () => {
  // The catalog is enumerated rather than a computed list of names deleted,
  // so anything hand-made is visible here. Visible is not the same as owned:
  // dropping a table this module did not create would be the worst possible
  // reading of "retention".
  await ensurePartitions(pool, utc('2030-06-15T00:00:00Z'))
  await pool.query(`
    CREATE TABLE request_logs_archive PARTITION OF request_logs
    FOR VALUES FROM ('${monthBound(utc('2020-01-01T00:00:00Z'))}')
                 TO ('${monthBound(utc('2020-02-01T00:00:00Z'))}')
  `)

  const dropped = await dropExpiredPartitions(pool, utc('2030-06-15T00:00:00Z'), 1)

  expect(dropped).not.toContain('request_logs_archive')
  expect(await partitions()).toContain('request_logs_archive')
  await pool.query('DROP TABLE request_logs_archive')
})
```

Add `beforeEach(resetDb)` above the arithmetic tests — the integration tests need a clean slate, and `resetDb` gains partition provisioning in Task 4. For now add it as:

```ts
beforeEach(resetDb)
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run tests/lib/logs/partitions.test.ts`
Expected: the 6 arithmetic tests PASS; the 8 integration tests FAIL with `ensurePartitions is not a function`.

- [ ] **Step 7: Implement create and drop**

Append to `src/lib/logs/partitions.ts`:

```ts
/**
 * Creates the current month's partition and the next `MONTHS_AHEAD`.
 * Returns the names actually created, so a caller can report real work rather
 * than a fixed list that says the same thing on every run.
 *
 * `IF NOT EXISTS` makes this idempotent, which is what lets it run at every
 * boot and on every tick without a "have I already done this" query.
 *
 * Each statement takes a brief AccessExclusiveLock on the parent, blocking
 * writes for its duration. That is sub-millisecond for an empty new partition,
 * and it is the reason partitions are made months ahead by a background job
 * rather than on the insert path.
 */
export async function ensurePartitions(client: Queryable, now: Date): Promise<string[]> {
  const created: string[] = []

  for (let ahead = 0; ahead <= MONTHS_AHEAD; ahead += 1) {
    const start = addMonths(now, ahead)
    const name = partitionName(start)
    const { rows } = await client.query(`
      SELECT to_regclass('public.${name}') IS NULL AS missing
    `)
    if (rows[0]?.missing !== true) continue

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${name} PARTITION OF request_logs
      FOR VALUES FROM ('${monthBound(start)}') TO ('${monthBound(addMonths(start, 1))}')
    `)
    created.push(name)
  }

  return created
}

/**
 * Drops every month that falls outside the keep window: the current month and
 * the `retentionMonths - 1` before it. `0` keeps everything.
 *
 * The partitions are read from the catalog rather than computed as a list of
 * names to delete. The catalog is the truth — a partition left by an older
 * naming scheme, or created by hand, is visible this way and invisible the
 * other. Anything whose name does not parse as request_logs_YYYY_MM is left
 * alone: this module drops what it made, not whatever it finds attached.
 */
export async function dropExpiredPartitions(
  client: Queryable,
  now: Date,
  retentionMonths: number,
): Promise<string[]> {
  if (retentionMonths <= 0) return []

  const keepFrom = addMonths(now, -(retentionMonths - 1))
  const { rows } = await client.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs'
    ORDER BY c.relname
  `)

  const dropped: string[] = []
  for (const row of rows) {
    const name = String(row.name)
    const match = PARTITION_RE.exec(name)
    if (!match) continue

    const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
    if (start >= keepFrom) continue

    await client.query(`DROP TABLE IF EXISTS ${name}`)
    dropped.push(name)
  }

  return dropped
}
```

Partition names are interpolated rather than parameterised because Postgres does not accept a bind parameter where an identifier belongs. Every name that reaches a `CREATE`/`DROP` is either built by `partitionName` from a `Date`, or matched by `PARTITION_RE` — nothing user-supplied reaches this SQL.

- [ ] **Step 8: Run the whole file**

Run: `pnpm vitest run tests/lib/logs/partitions.test.ts`
Expected: PASS, 14 tests. If `resetDb` fails on `request_payloads` not existing, that is Task 4 — do Task 4's Step 1 now and come back.

- [ ] **Step 9: Commit**

```bash
git add src/lib/logs/partitions.ts tests/lib/logs/partitions.test.ts
git commit -m "feat(logs): add month-partition create and drop"
```

---

### Task 4: Teach the test harness about partitions

**Files:**
- Modify: `tests/helpers/db.ts`

**Interfaces:**
- Consumes: `ensurePartitions` from Task 3.
- Produces: `resetDb()` leaves the current month provisioned. Every test that writes a log row depends on this.

- [ ] **Step 1: Rewrite `resetDb`**

Task 3 Step 0 already removed `request_payloads` from `TABLES`. What this step adds is the provisioning call and the comment explaining why it is needed. Write the file to exactly the state below.

```ts
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { ensurePartitions } from '@/lib/logs/partitions'

const TABLES = [
  'request_logs',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]

/**
 * TRUNCATE on the partitioned parent empties its partitions but leaves them
 * attached, so the reset alone would be enough — except that a maintenance
 * test drops partitions for real. With no DEFAULT partition to absorb a
 * write, a test running after one of those would fail on "no partition of
 * relation" for reasons that have nothing to do with what it asserts.
 * Re-provisioning here makes that impossible.
 */
export async function resetDb() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )
  await ensurePartitions(pool, new Date())
}

export { db as testDb }
```

- [ ] **Step 2: Verify the partitions module's own tests still pass**

Run: `pnpm vitest run tests/lib/logs/partitions.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/db.ts
git commit -m "test: provision request_log partitions on reset"
```

---

### Task 5: Move the store contract to ids and maintenance

**Files:**
- Modify: `src/lib/logs/types.ts:23-61`, `src/lib/logs/types.ts:87-104`
- Modify: `src/lib/logs/line.ts:29`
- Modify: `src/lib/logs/stdout.ts:21,28-31`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RequestLogEntry.id: string` (replaces `requestId`)
  - `MaintenanceResult { created: string[]; dropped: string[] }`
  - `BaseSink.maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult>` (replaces `prune`)
  - `ReadableRequestLogStore.get(id: string)`
  - `LogRow` without `requestId`
  - `LogDetail.payload: LogPayload | null` unchanged in shape

- [ ] **Step 1: Update the entry and sink types**

In `src/lib/logs/types.ts`, change `RequestLogEntry`'s first field and the sink interfaces:

The settings import must be `import type`, not a value import. `src/lib/settings.ts` starts with `import 'server-only'`, and `types.ts` is reachable from client components; a value import would drag that into a client bundle and fail the build. A type-only import is erased.

```ts
import type { LoggingSettings } from '@/lib/settings'

export interface RequestLogEntry {
  /** The v7 uuid minted at request start. Primary key, x-request-id, and the
   * partition key — one value for the request's whole life. */
  id: string
  keyId: string | null
  // ... rest unchanged
}

export interface MaintenanceResult {
  /** Partition names created and dropped, for the Settings status line.
   * Names rather than a row count: dropping a partition never counts the rows
   * inside it, and a number that was sometimes real and sometimes a guess
   * would be worse than no number. */
  created: string[]
  dropped: string[]
}

interface BaseSink {
  readonly name: string
  write(entry: RequestLogEntry): Promise<void>
  /** Provision storage ahead of time and discard what has aged out. A driver
   * with no storage of its own returns empty arrays. */
  maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult>
  /** Drain anything buffered. Called on shutdown. */
  flush?(): Promise<void>
}

export interface ReadableRequestLogStore extends BaseSink {
  readonly readable: true
  query(filter: LogFilter): Promise<LogPage>
  /** By primary key. Returns null for anything that is not a uuid. */
  get(id: string): Promise<LogDetail | null>
}
```

- [ ] **Step 2: Remove `requestId` from `LogRow`**

Delete the `requestId: string` line from `LogRow`. `id` already carries it.

- [ ] **Step 3: Update the stdout line**

In `src/lib/logs/line.ts`, change `request_id: entry.requestId,` to `request_id: entry.id,`. The key name stays `request_id` — it is what a log aggregator's saved queries already match on, and it is still exactly what the client received.

- [ ] **Step 4: Update the stdout driver**

In `src/lib/logs/stdout.ts`, change the error line's `entry.requestId` to `entry.id`, and replace `prune`:

```ts
  /** stdout has no storage of its own — the log shipper owns retention. */
  async maintain(): Promise<MaintenanceResult> {
    return { created: [], dropped: [] }
  },
```

Update the import to `import type { MaintenanceResult, RequestLogEntry, WriteOnlySink } from './types'`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL, in `src/lib/logs/postgres.ts` (Task 6), `src/lib/logs/retention.ts` (Task 7), `src/lib/gateway/chat-handler.ts` (Task 7), `src/lib/admin/logs.ts` and the log pages (Task 9), and the tests (Task 8). `src/lib/logs/line.ts` and `stdout.ts` must be clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/types.ts src/lib/logs/line.ts src/lib/logs/stdout.ts
git commit -m "refactor(logs): key entries by their v7 id, replace prune with maintain"
```

---

### Task 6: Rewrite the postgres driver

**Files:**
- Modify: `src/lib/logs/postgres.ts` (whole file)
- Test: `tests/lib/logs/postgres-store.test.ts`

**Interfaces:**
- Consumes: `RequestLogEntry.id`, `MaintenanceResult` (Task 5); `ensurePartitions`, `dropExpiredPartitions` (Task 3).
- Produces: `postgresStore` satisfying `ReadableRequestLogStore` — `write` is a single INSERT, `get(id)` validates the uuid, `maintain(now, settings)` provisions and drops.

- [ ] **Step 1: Rewrite the failing tests first**

Replace `tests/lib/logs/postgres-store.test.ts` wholesale. The identity handle changes from `requestId` to `id`, so every assertion moves with it:

```ts
import { beforeEach, expect, test } from 'vitest'
import { postgresStore } from '@/lib/logs/postgres'
import { uuidv7 } from '@/lib/uuid'
import type { RequestLogEntry } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(),
    keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('a written entry comes back from query under the id it was given', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, model: 'house-model' }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ id, model: 'house-model', status: 200 })
})

test('get returns the attempt chain and the payload', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({
    id,
    attempts: [
      { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
      { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
    ],
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }))

  const detail = await postgresStore.get(id)
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0].error).toBe('down')
  expect(detail?.payloadCaptured).toBe(true)
  expect(detail?.payload?.request).toEqual({ model: 'house-model' })
  expect(detail?.payload?.truncated).toBe(false)
})

test('get returns null for an unknown id', async () => {
  expect(await postgresStore.get(uuidv7())).toBeNull()
})

test('get returns null rather than throwing for a malformed id', async () => {
  // A hand-edited URL reaches this with anything at all. Without the guard the
  // string reaches a uuid column comparison and Postgres raises "invalid input
  // syntax for type uuid" — a 500 where a 404 belongs.
  expect(await postgresStore.get('not-a-uuid')).toBeNull()
  expect(await postgresStore.get('')).toBeNull()
  expect(await postgresStore.get("'; DROP TABLE request_logs; --")).toBeNull()
})

test('an entry without a payload records payload_captured false', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id }))
  const detail = await postgresStore.get(id)
  expect(detail?.payloadCaptured).toBe(false)
  expect(detail?.payload).toBeNull()
})

test('a truncated payload keeps its flag', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({
    id,
    payload: { request: { truncated: true, bytes: 91234, preview: 'x' }, response: null, truncated: true },
  }))
  expect((await postgresStore.get(id))?.payload?.truncated).toBe(true)
})

test('filters by key, model, status class and outcome', async () => {
  const ok1 = uuidv7(); const bad = uuidv7(); const oops = uuidv7()
  await postgresStore.write(entry({ id: ok1, model: 'a', status: 200, outcome: 'ok' }))
  await postgresStore.write(entry({ id: bad, model: 'b', status: 429, outcome: 'error' }))
  await postgresStore.write(entry({ id: oops, model: 'a', status: 502, outcome: 'error' }))

  expect((await postgresStore.query({ limit: 10, model: 'a' })).rows).toHaveLength(2)
  expect((await postgresStore.query({ limit: 10, statusClass: 'client_error' })).rows)
    .toMatchObject([{ id: bad }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'server_error' })).rows)
    .toMatchObject([{ id: oops }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'success' })).rows)
    .toMatchObject([{ id: ok1 }])
  expect((await postgresStore.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(2)
})

test('pages newest first and walks both directions', async () => {
  const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  for (const id of ids) await postgresStore.write(entry({ id }))
  const [r1, r2, r3, r4, r5] = ids

  const first = await postgresStore.query({ limit: 2 })
  expect(first.rows.map((r) => r.id)).toEqual([r5, r4])
  expect(first.nextCursor).not.toBeNull()

  const second = await postgresStore.query({ limit: 2, after: first.nextCursor! })
  expect(second.rows.map((r) => r.id)).toEqual([r3, r2])

  const back = await postgresStore.query({ limit: 2, before: second.prevCursor! })
  expect(back.rows.map((r) => r.id)).toEqual([r5, r4])
  expect(r1).toBeDefined()
})

test('prevCursor is null once before-paging reaches the newest row', async () => {
  const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  for (const id of ids) await postgresStore.write(entry({ id }))

  const top = await postgresStore.query({ limit: 2, before: ids[3] })
  expect(top.rows.map((r) => r.id)).toEqual([ids[4]])
  expect(top.prevCursor).toBeNull()
})

test('an over-long model name is truncated rather than failing the write', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, model: 'm'.repeat(400) }))
  expect((await postgresStore.get(id))?.model).toHaveLength(128)
})

test('a time range filter selects by id bound', async () => {
  const older = uuidv7(new Date('2030-04-10T00:00:00Z'))
  const newer = uuidv7(new Date('2030-05-10T00:00:00Z'))
  await postgresStore.write(entry({ id: older }))
  await postgresStore.write(entry({ id: newer }))

  const rows = (await postgresStore.query({ limit: 10, from: new Date('2030-05-01T00:00:00Z') })).rows
  expect(rows).toMatchObject([{ id: newer }])
})

test('paging crosses a partition boundary', async () => {
  // Two months, so the query is a Merge Append over two partitions rather
  // than a scan of one. Keyset paging has to stay correct across that seam.
  const april = uuidv7(new Date('2030-04-20T00:00:00Z'))
  const may = uuidv7(new Date('2030-05-20T00:00:00Z'))
  await postgresStore.write(entry({ id: april }))
  await postgresStore.write(entry({ id: may }))

  const first = await postgresStore.query({ limit: 1 })
  expect(first.rows.map((r) => r.id)).toEqual([may])
  const second = await postgresStore.query({ limit: 1, after: first.nextCursor! })
  expect(second.rows.map((r) => r.id)).toEqual([april])
})

test('maintain provisions the current month and drops what fell out of the window', async () => {
  const now = new Date('2030-06-15T00:00:00Z')
  const settings = { store: 'postgres', retentionMonths: 2, payloadMaxBytes: 1024 }

  await postgresStore.maintain(new Date('2030-01-15T00:00:00Z'), settings)
  const result = await postgresStore.maintain(now, settings)

  expect(result.created).toContain('request_logs_2030_06')
  expect(result.dropped).toContain('request_logs_2030_01')
  expect(result.dropped).not.toContain('request_logs_2030_06')
})
```

Note the 2030 dates: they are far enough ahead that `resetDb`'s provisioning of the real current month never collides with them, and far enough from `dropExpiredPartitions`' keep window that the intent of each test is unambiguous.

`uuidv7(date)` already accepts a `Date` — see `src/lib/uuid.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: FAIL — `requestPayloads` import errors and `postgresStore.maintain is not a function`.

- [ ] **Step 3: Rewrite the driver's imports, columns, and write path**

In `src/lib/logs/postgres.ts`: drop `requestPayloads` from the schema import, drop the now-unused `PRUNE_BATCH` constant, and add the partition imports.

```ts
import 'server-only'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { uuidv7Bound } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import { dropExpiredPartitions, ensurePartitions } from './partitions'
import type {
  LogDetail, LogFilter, LogPage, LogRow, MaintenanceResult, ReadableRequestLogStore,
  RequestLogEntry,
} from './types'

const MODEL_MAX_LENGTH = 128

/** Cursors and detail ids arrive from a URL. A non-uuid reaching a uuid
 * column comparison is an unhandled Postgres error, so it is rejected here
 * and read as "no such row". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
```

Remove `requestId` from `LIST_COLUMNS` (`id` is already there).

Replace the `write` method:

```ts
  async write(entry: RequestLogEntry): Promise<void> {
    // One row. The payload columns live here, so the two-row transaction this
    // replaced — and the window where a log row could claim a payload that
    // was never written — are both gone.
    await db.insert(requestLogs).values({
      id: entry.id,
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
      requestJson: entry.payload?.request ?? null,
      responseJson: entry.payload?.response ?? null,
      payloadTruncated: entry.payload?.truncated ?? false,
    })
  },
```

- [ ] **Step 4: Rewrite `get` and replace `prune` with `maintain`**

```ts
  async get(id: string): Promise<LogDetail | null> {
    if (!UUID_RE.test(id)) return null

    const [log] = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.id, id))
      .limit(1)

    if (!log) return null

    return {
      id: log.id,
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
      // payload_captured is the flag; the columns are the fact. Trusting the
      // flag over the columns would render an empty payload block for a row
      // whose body was never stored.
      payload: log.payloadCaptured
        ? { request: log.requestJson, response: log.responseJson, truncated: log.payloadTruncated }
        : null,
    }
  },

  /**
   * Provision ahead, then discard what aged out — in that order. If the drop
   * half throws, the months that keep writes landing have already been made.
   */
  async maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult> {
    const created = await ensurePartitions(pool, now)
    const dropped = await dropExpiredPartitions(pool, now, settings.retentionMonths)
    return { created, dropped }
  },
}
```

Delete the whole old `prune` method.

- [ ] **Step 5: Run the driver tests**

Run: `pnpm vitest run tests/lib/logs/postgres-store.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/postgres.ts tests/lib/logs/postgres-store.test.ts
git commit -m "feat(logs): single-row writes, id lookup, partition maintenance"
```

---

### Task 7: Settings in months, and the id minted at request start

**Files:**
- Modify: `src/lib/settings.ts:59-124`
- Modify: `src/lib/gateway/chat-handler.ts:138`, and its import block
- Test: `tests/lib/logging-settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_RETENTION_MONTHS = 3`, `LoggingSettings.retentionMonths: number`, settings key `logs.retention_months`. `chat-handler` mints `requestId` with `uuidv7()`.

- [ ] **Step 1: Write the failing settings test**

Replace the retention test in `tests/lib/logging-settings.test.ts` with:

```ts
test('retention is stored in months and rejects fractions and negatives', async () => {
  expect((await setLoggingSettings({ retentionMonths: 6 })).retentionMonths).toBe(6)
  expect((await setLoggingSettings({ retentionMonths: 0 })).retentionMonths).toBe(0)
  await expect(setLoggingSettings({ retentionMonths: -1 })).rejects.toThrow(/whole number of months/)
  await expect(setLoggingSettings({ retentionMonths: 1.5 })).rejects.toThrow(/whole number of months/)
})

test('retention falls back to the default when unset', async () => {
  expect((await getLoggingSettings()).retentionMonths).toBe(DEFAULT_RETENTION_MONTHS)
})
```

Update that file's imports to pull `DEFAULT_RETENTION_MONTHS` instead of `DEFAULT_RETENTION_DAYS`, and adjust any other assertion in the file that names `retentionDays`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/lib/logging-settings.test.ts`
Expected: FAIL — `DEFAULT_RETENTION_MONTHS` is not exported.

- [ ] **Step 3: Change the settings module**

In `src/lib/settings.ts`:

```ts
export const DEFAULT_LOG_STORE = 'postgres'
export const DEFAULT_RETENTION_MONTHS = 3
export const DEFAULT_PAYLOAD_MAX_BYTES = 262_144

export interface LoggingSettings {
  store: string
  /**
   * Calendar months kept: the current one plus the `retentionMonths - 1`
   * before it. `0` keeps everything.
   *
   * Months rather than days because a monthly partition can only be discarded
   * whole. A day-granular setting would either lie — 30 keeping up to 60 days
   * of prompt content — or need a row-level DELETE path kept alive purely to
   * honour the last few days.
   */
  retentionMonths: number
  payloadMaxBytes: number
}

const LOG_KEYS = {
  store: 'logs.store',
  retentionMonths: 'logs.retention_months',
  payloadMaxBytes: 'logs.payload_max_bytes',
} as const
```

In `getLoggingSettings`, read `LOG_KEYS.retentionMonths` into `retentionMonths` with `DEFAULT_RETENTION_MONTHS` as the fallback. In `setLoggingSettings`, replace the `retentionDays` branch:

```ts
  if (patch.retentionMonths !== undefined) {
    if (!Number.isInteger(patch.retentionMonths) || patch.retentionMonths < 0) {
      throw new Error('Log retention must be a whole number of months, or 0 to keep everything.')
    }
    writes.push([LOG_KEYS.retentionMonths, patch.retentionMonths])
  }
```

- [ ] **Step 4: Run the settings test**

Run: `pnpm vitest run tests/lib/logging-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Mint the id at request start**

In `src/lib/gateway/chat-handler.ts`, add `import { uuidv7 } from '@/lib/uuid'` alongside the existing imports, and replace line 138:

```ts
  // The request's one identifier: returned as x-request-id, printed on the
  // stdout line, stored as the log's primary key, and — because it is a v7
  // uuid — the partition that log row lands in. Minted here rather than at
  // insert, because the header goes out long before the row is written.
  const requestId = uuidv7()
```

`newCompletionId` is still imported and still used for the response body's `chatcmpl-…` id at line 247 — leave that alone.

- [ ] **Step 6: Pass the id into the log entry**

In the same file, find the `await logRequest({` call and change its first field from `requestId,` to `id: requestId,`.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL only in `src/lib/logs/retention.ts` (Task 8), `src/lib/admin/logs.ts` and the admin pages (Task 9), and tests updated in Tasks 8–9. `settings.ts` and `chat-handler.ts` must be clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/settings.ts src/lib/gateway/chat-handler.ts tests/lib/logging-settings.test.ts
git commit -m "feat(logs): retention in months; mint the request id at request start"
```

---

### Task 8: The maintenance job

**Files:**
- Rename: `src/lib/logs/retention.ts` → `src/lib/logs/maintenance.ts`
- Rename: `tests/lib/logs/retention.test.ts` → `tests/lib/logs/maintenance.test.ts`
- Modify: `src/instrumentation.ts`
- Modify: `src/lib/logs/index.ts` (re-exports, if it names retention)

**Interfaces:**
- Consumes: `store.maintain` (Tasks 5–6), `LoggingSettings.retentionMonths` (Task 7).
- Produces:
  - `PARTITION_LOCK_KEY: bigint`
  - `runLogMaintenance(now?: Date): Promise<MaintenanceResult | null>` — `null` when the lock is held elsewhere
  - `startPartitionMaintenance(): Promise<void>` — awaited boot run, then a 24 h timer
  - settings row `logs.last_maintenance` = `{ at, created, dropped }`

- [ ] **Step 1: Rename both files with git**

```bash
git mv src/lib/logs/retention.ts src/lib/logs/maintenance.ts
git mv tests/lib/logs/retention.test.ts tests/lib/logs/maintenance.test.ts
```

- [ ] **Step 2: Rewrite the test file**

Replace `tests/lib/logs/maintenance.test.ts` entirely:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { PARTITION_LOCK_KEY, runLogMaintenance } from '@/lib/logs/maintenance'
import { setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

async function partitions(): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs'
    ORDER BY c.relname
  `)
  return rows.map((row) => String(row.name))
}

test('provisions the months ahead of now', async () => {
  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.created).toEqual(expect.arrayContaining([
    'request_logs_2030_06', 'request_logs_2030_07',
    'request_logs_2030_08', 'request_logs_2030_09',
  ]))
})

test('drops months that fell outside the retention window', async () => {
  await setLoggingSettings({ retentionMonths: 2 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2030-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toContain('request_logs_2030_01')
  expect(await partitions()).not.toContain('request_logs_2030_01')
})

test('zero retention still provisions but drops nothing', async () => {
  await setLoggingSettings({ retentionMonths: 0 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2029-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toEqual([])
  expect(result?.created).toContain('request_logs_2030_06')
  expect(await partitions()).toContain('request_logs_2029_01')
})

test('maintains a non-active store rather than only the configured one', async () => {
  // request_logs holds captured prompt and completion content. Switching the
  // active store to stdout must not leave that data unpruned forever just
  // because reads no longer go through postgres.
  await setLoggingSettings({ store: 'stdout', retentionMonths: 2 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2030-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toContain('request_logs_2030_01')
})

test('skips the run when another instance holds the lock', async () => {
  const holder = await pool.connect()
  await holder.query('SELECT pg_advisory_lock($1)', [PARTITION_LOCK_KEY.toString()])

  try {
    expect(await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))).toBeNull()
    expect(await partitions()).not.toContain('request_logs_2030_06')
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [PARTITION_LOCK_KEY.toString()])
    holder.release()
  }
})

test('releases the lock so the next run proceeds', async () => {
  await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))
  expect(await runLogMaintenance(new Date('2030-07-15T00:00:00Z'))).not.toBeNull()
})

test('records when it last ran and what it did', async () => {
  await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  const rows = await db.execute(
    sql`SELECT value FROM settings WHERE key = 'logs.last_maintenance'`,
  )
  expect(rows.rowCount).toBe(1)
  const value = rows.rows[0].value as { at: string; created: string[]; dropped: string[] }
  expect(value.created).toContain('request_logs_2030_06')
  expect(Array.isArray(value.dropped)).toBe(true)
  expect(typeof value.at).toBe('string')
})

test('pins the advisory lock and its unlock to one connection', async () => {
  // pg_try_advisory_lock/pg_advisory_unlock are scoped to the session that
  // issued them. This does not prove cross-process exclusion — the "skips the
  // run" test above covers that — it proves the lock and its unlock are
  // issued on one client checked out with pool.connect(), rather than as two
  // independent db.execute() calls that could each land on a different pooled
  // connection, leaking the lock on the one that took it.
  //
  // pool.connect is also invoked internally, in its callback form, by every
  // pool.query() — which is what the settings read, the DDL, and the
  // last_maintenance upsert all use. Those must pass through undisturbed or
  // the test hangs on a callback the mock swallowed. Only the explicit,
  // no-argument, promise-returning call that runLogMaintenance itself makes
  // is instrumented.
  const queries: string[] = []
  let explicitConnects = 0
  let querySpy: ReturnType<typeof vi.spyOn> | undefined
  const originalConnect = pool.connect.bind(pool)
  const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(((cb?: unknown) => {
    if (typeof cb === 'function') {
      return (originalConnect as unknown as (cb: unknown) => void)(cb)
    }

    explicitConnects += 1
    return (async () => {
      const client = await originalConnect()
      const originalQuery = client.query.bind(client)
      querySpy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
        queries.push(String(args[0]))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalQuery as any)(...args)
      }) as typeof client.query)
      return client
    })()
  }) as typeof pool.connect)

  try {
    expect(await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))).not.toBeNull()
  } finally {
    connectSpy.mockRestore()
    querySpy?.mockRestore()
  }

  expect(explicitConnects).toBe(1)
  const lockIndex = queries.findIndex((q) => q.includes('pg_try_advisory_lock'))
  const unlockIndex = queries.findIndex((q) => q.includes('pg_advisory_unlock'))
  expect(lockIndex).toBeGreaterThanOrEqual(0)
  expect(unlockIndex).toBeGreaterThan(lockIndex)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/lib/logs/maintenance.test.ts`
Expected: FAIL — `PARTITION_LOCK_KEY` and `runLogMaintenance` are not exported.

- [ ] **Step 4: Rewrite the job**

Replace `src/lib/logs/maintenance.ts`. The advisory-lock discipline is carried over verbatim from `retention.ts` — it is the fix from an earlier review round and the comments explaining it must survive the rename.

```ts
import 'server-only'
import { db, pool } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { DRIVERS, resolveRequestLogStore } from './registry'
import type { MaintenanceResult } from './types'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from the
 * migration runner's key in scripts/migrate.mjs. */
export const PARTITION_LOCK_KEY = BigInt(5_512_998_004_117_336)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Provisions request-log partitions ahead of time and drops those that have
 * aged out of the retention window.
 *
 * Maintains every registered driver, not just the one currently configured
 * for reads: switching the active store must not silently stop retention on
 * data that still exists in a store the gateway is no longer reading from.
 * request_logs holds captured prompt and completion content, so leaving it
 * unmaintained after a store switch would be a data-retention bug rather than
 * a cosmetic one. A driver with no storage of its own contributes nothing and
 * is harmless in the loop.
 *
 * Returns what was created and dropped, or null when another instance is
 * already running.
 */
export async function runLogMaintenance(
  now: Date = new Date(),
): Promise<MaintenanceResult | null> {
  const { settings: config } = await resolveRequestLogStore()

  // pg_try_advisory_lock / pg_advisory_unlock are scoped to the session that
  // took them. `db` wraps a shared pool: a bare db.execute() checks out
  // *some* idle client, runs one statement, and hands it back, so the lock
  // and its unlock could land on two different backends. The unlock would
  // then silently no-op on a connection that never held the lock, leaking it
  // on the one that did — and with pg_try_advisory_lock, every later run
  // would just find it still held and skip, with no error anywhere. Pinning
  // both calls to one held client is what keeps them on the same session.
  const client = await pool.connect()
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [PARTITION_LOCK_KEY.toString()],
    )
    if (!locked.rows[0]?.locked) return null

    try {
      const result: MaintenanceResult = { created: [], dropped: [] }
      for (const driver of Object.values(DRIVERS)) {
        const done = await driver.maintain(now, config)
        result.created.push(...done.created)
        result.dropped.push(...done.dropped)
      }

      const value = { at: new Date().toISOString(), ...result }
      await db
        .insert(settings)
        .values({ key: 'logs.last_maintenance', value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        })

      return result
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [PARTITION_LOCK_KEY.toString()])
      } catch (err) {
        // The run's own outcome is already decided by this point. Rethrowing
        // here would replace a real failure from driver.maintain with the
        // unlock's instead, hiding the root cause — so it is logged and
        // carried to release() below, which destroys the client rather than
        // recycling one that may still hold the lock.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error('[gateway] could not release the log maintenance lock', err)
      }
    }
  } finally {
    client.release(unlockError)
  }
}

let timer: NodeJS.Timeout | null = null

/**
 * Runs maintenance once, now, and then daily.
 *
 * The first run is awaited before the instance serves anything. There is no
 * DEFAULT partition, so a database whose partitions do not exist yet cannot
 * accept a log write at all — a fresh install is provisioned by this call.
 *
 * A failure here is logged and swallowed rather than propagated: a logging
 * problem must not become a serving problem. It is logged loudly because the
 * consequence is silently discarded log lines rather than a visibly degraded
 * page, and that is not something an operator can be left to discover.
 *
 * Idempotent, because Next may evaluate a module more than once in
 * development.
 */
export async function startPartitionMaintenance(): Promise<void> {
  if (timer) return

  timer = setInterval(() => {
    void runLogMaintenance().catch((err) =>
      console.error('[gateway] request log maintenance failed', err),
    )
  }, DAY_MS)
  // Never hold the process open for a log-housekeeping timer.
  timer.unref()

  try {
    await runLogMaintenance()
  } catch (err) {
    console.error('[gateway] initial request log maintenance failed', err)
  }
}
```

- [ ] **Step 5: Run the maintenance tests**

Run: `pnpm vitest run tests/lib/logs/maintenance.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Wire the boot hook**

In `src/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startPartitionMaintenance } = await import('@/lib/logs/maintenance')
  await startPartitionMaintenance()
}
```

The `await` is load-bearing: with no `DEFAULT` partition, serving before the current month exists means every log write fails.

- [ ] **Step 7: Check the barrel re-exports**

Run: `grep -rn "retention" src/lib/logs/index.ts src/lib/ --include=*.ts`
Expected: no hits outside `maintenance.ts`'s own prose. Fix any stale import path the grep turns up.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm test`
Expected: PASS. Remaining failures should be confined to `tests/lib/db/request-logs-schema.test.ts`, `tests/lib/admin/logs.test.ts`, `tests/lib/logs/stdout.test.ts`, `tests/lib/logs/registry.test.ts`, and `tests/gateway/payload-capture.test.ts` — all of which still name `requestId`. Fix them now: replace `requestId: 'req_x'` with `id: uuidv7()` in every entry literal, drop `requestPayloads` assertions, and change the schema test's insert to supply an explicit `id`. `tests/lib/db/request-logs-schema.test.ts` loses its cascade test entirely — there is nothing left to cascade to — and gains one asserting a row routes to the partition its id encodes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(logs): boot and daily partition maintenance under an advisory lock"
```

---

### Task 9: Move the UI to id addressing and months

**Files:**
- Rename: `src/app/(admin)/logs/[requestId]/` → `src/app/(admin)/logs/[id]/`
- Modify: `src/app/(admin)/logs/[id]/page.tsx`, `src/app/(admin)/logs/page.tsx:117`, `src/app/(admin)/logs/log-filters.tsx`
- Modify: `src/lib/admin/logs.ts:110-118`
- Modify: `src/app/(admin)/settings/page.tsx`, `actions.ts`, `governance-form.tsx`
- Test: `tests/lib/admin/logs.test.ts`

**Interfaces:**
- Consumes: `store.get(id)` (Task 6), `retentionMonths` (Task 7), `logs.last_maintenance` (Task 8).
- Produces: `loadLogDetail(id: string)`; the detail route at `/logs/<uuid>`.

- [ ] **Step 1: Rename the route segment**

```bash
git mv "src/app/(admin)/logs/[requestId]" "src/app/(admin)/logs/[id]"
```

- [ ] **Step 2: Update the detail page**

In `src/app/(admin)/logs/[id]/page.tsx`, change the params type and destructuring:

```ts
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const log = await loadLogDetail(decodeURIComponent(id))
  if (!log) notFound()
```

and change the header's `title={log.requestId}` to `title={log.id}`.

- [ ] **Step 3: Update the list link and the lookup box**

In `src/app/(admin)/logs/page.tsx:117`, change `href={`/logs/${row.requestId}`}` to `href={`/logs/${row.id}`}`. If the same cell renders `row.requestId` as its text, render `row.id` instead.

In `src/app/(admin)/logs/log-filters.tsx`, the lookup box already navigates to `/logs/<value>`; update its `aria-label` and placeholder to say the request id is a uuid, so a user pasting `req_…` from an old habit is not left guessing.

- [ ] **Step 4: Rename the `loadLogDetail` parameter**

In `src/lib/admin/logs.ts`, change `loadLogDetail(requestId: string)` to `loadLogDetail(id: string)` and pass `id` to `store.get`.

- [ ] **Step 5: Update the Settings page's status line**

In `src/app/(admin)/settings/page.tsx`, replace the `prune` helper and the query it feeds:

```ts
/** Renders the `logs.last_maintenance` settings row. No row yet — a fresh
 * install whose first run has not finished — reads as "never" rather than a
 * blank line. */
function maintenance(
  value: { at: string; created: string[]; dropped: string[] } | null,
): string {
  if (!value) return 'never'
  const at = value.at.slice(0, 19).replace('T', ' ')
  return `${at} — ${value.created.length} created, ${value.dropped.length} dropped`
}
```

Change the settings query's key to `'logs.last_maintenance'`, rename the destructured `[lastPrune]` to `[lastRun]`, pass `settings.retentionMonths` to `GovernanceForm`, and update the label under the form to read `Maintenance last ran: {maintenance(...)}`.

- [ ] **Step 6: Update the server action**

In `src/app/(admin)/settings/actions.ts`, replace the `retentionDays` block:

```ts
  const retentionRaw = formData.get('retentionMonths')
  if (typeof retentionRaw !== 'string' || retentionRaw.trim() === '') {
    return { error: 'Retention is required — enter 0 to keep everything.' }
  }
  const retentionMonths = Number(retentionRaw)
  if (!Number.isFinite(retentionMonths)) {
    return { error: 'Retention must be a number.' }
  }
```

and pass `retentionMonths` to `setLoggingSettings`.

- [ ] **Step 7: Update the governance form**

In `src/app/(admin)/settings/governance-form.tsx`, rename the `retentionDays` prop to `retentionMonths` in both the type and the destructuring, and replace the field:

```tsx
      <div className="space-y-2">
        <Label htmlFor="retentionMonths">Retention (months)</Label>
        <Input
          id="retentionMonths" name="retentionMonths" type="number" min={0} required
          defaultValue={retentionMonths}
        />
        <p className="text-xs text-muted-foreground">
          Logs are stored one month per table and discarded a whole month at a time,
          daily. A value of N keeps the current month and the N−1 before it, so the
          youngest logs are always kept in full. Set 0 to keep everything, which means
          you are responsible for the database&apos;s growth.
        </p>
      </div>
```

The copy states the coarseness plainly — an operator who needs day-granular deletion of prompt content is not served by this design and should not have to discover that from behaviour.

- [ ] **Step 8: Update the admin test**

In `tests/lib/admin/logs.test.ts`, replace any `requestId` in a filter or row fixture with `id`. If it asserts on `loadLogDetail`, pass a uuid and add one case asserting a malformed id yields `null` rather than throwing.

- [ ] **Step 9: Typecheck, lint, and run the suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all three clean. The suite should be back to **60 files** with the count moved from 642 by the tests added and removed above.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(admin): address logs by id, express retention in months"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Find what the README already claims**

Run: `grep -n "request_id\|retention\|req_\|payload" README.md`
Expected: the Governance section and the `docker compose logs` grep example. Every hit is a candidate for the edits below.

- [ ] **Step 2: Correct the request id**

Change any `x-request-id: req_…` example to a v7 uuid, and update the `docker compose logs` grep so it matches the new value. State plainly that the id in the header is the same id as the log row's primary key and the detail page's URL.

- [ ] **Step 3: Document retention and partitioning**

Add to the Governance section: request logs are stored one partition per calendar month (UTC); retention is expressed in months and drops whole partitions daily; a value of N keeps the current month and the N−1 before it, so the youngest logs are always kept in full; `0` keeps everything. Say that partitions are provisioned three months ahead by a job that runs at boot and every 24 hours, and that there is no default partition, so a database whose maintenance job has been failing for a full quarter will start refusing log writes — loudly, in stderr.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: request log partitioning, month retention, uuid request ids"
```

---

### Task 11: Verify the whole change end to end

**Files:** none modified.

- [ ] **Step 1: Prove a fresh database provisions itself**

```bash
docker exec babellm-test-postgres-test-1 \
  psql -U babellm -d postgres -c 'DROP DATABASE IF EXISTS babellm_test'
pnpm test
```

Expected: green. This is the only check that exercises the real cold-start path — migration creates a parent with no partitions, and the harness provisions from there.

- [ ] **Step 2: Confirm the shape of what was built**

```bash
docker exec babellm-test-postgres-test-1 psql -U babellm -d babellm_test -c \
  "SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bounds
     FROM pg_inherits i
     JOIN pg_class p ON p.oid = i.inhparent
     JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs' ORDER BY c.relname" -c \
  "SELECT indexname FROM pg_indexes WHERE tablename LIKE 'request_logs_2%' ORDER BY 1" -c \
  "SELECT to_regclass('request_payloads') AS payloads"
```

Expected: four partitions named for the current month and the next three, each with `FOR VALUES FROM (…) TO (…)` uuid bounds; three indexes on each partition (pkey, api_key, model), proving the parent's indexes propagated; `payloads` empty.

- [ ] **Step 3: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all clean.

- [ ] **Step 4: Confirm nothing references the old shape**

```bash
grep -rn "request_payloads\|requestPayloads\|retentionDays\|retention_days\|last_prune\|pruneRequestLogs\|PRUNE_LOCK_KEY" src tests drizzle README.md
```

Expected: no output. Any hit is a leftover. The spec at `docs/superpowers/specs/2026-08-13-request-logs-design.md` legitimately mentions the old names while explaining what was removed — it is excluded from this grep on purpose.

- [ ] **Step 5: Commit anything outstanding**

```bash
git status --short
```

Expected: clean. If `AGENTS.md` shows as modified, commit it with the work — `next dev` rewrites that block, and leaving it uncommitted only recreates the change.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3 store contract — `maintain`, `MaintenanceResult`, `get(id)` | 5 |
| §3 module layout — `partitions.ts` | 3 |
| §4 uuid v7 minted at request start | 7 |
| §4 `request_logs` columns, no `request_id` | 1 |
| §4 indexes on the parent, no unique index but `id` | 1, 2 |
| §4 payloads in the row | 1, 6 |
| §4 partitioning, UTC months, no DEFAULT, parent-only migration | 2, 3 |
| §5 `retention_months`, `last_maintenance` | 7, 8 |
| §6 write path — single INSERT, id at start | 6, 7 |
| §7 `/logs/[id]`, uuid validation, banner copy | 6, 9 |
| §8 `partitions.ts`, `runLogMaintenance`, lock on one client, boot + 24 h | 3, 8 |
| §9 error handling — lock held, boot failure, no partition, bad id | 3, 6, 8 |
| §10 testing — arithmetic, maintenance, driver, gateway, harness | 3, 4, 6, 8, 9 |
| §11 consequences — README | 10 |

**Placeholder scan:** none. Every code step carries the code.

**Type consistency:** `MaintenanceResult` is `{ created, dropped }` in Tasks 5, 6, 8, 9. `runLogMaintenance` and `PARTITION_LOCK_KEY` are named identically in Task 8's test, implementation, and the spec. `ensurePartitions(client, now)` and `dropExpiredPartitions(client, now, retentionMonths)` keep their signatures across Tasks 3, 4, and 6. `retentionMonths` is the field name in Tasks 6, 7, 8, and 9.

**Known-red window:** the suite is not green between Task 2 and Task 8 Step 8. Each intervening task names the files expected to fail. This is called out at the top of the task list rather than left to be discovered.
