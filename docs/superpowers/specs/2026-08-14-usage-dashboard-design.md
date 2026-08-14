# Usage dashboard and hourly rollups

Status: design
Date: 2026-08-14

## 1. What this is

`/logs` answers "what happened in this request". Nothing answers "how much did
we spend last month", "which model is burning the budget", or "is this key's
traffic growing". The data is all there — `request_logs` carries tokens, cost,
latency and outcome per request — but reading it that way means scanning a
table that grows with every request the gateway ever serves.

This adds a pre-aggregated hourly rollup and a `/dashboard` page built on it.
The dashboard never reads `request_logs`. It reads `usage_rollups`, a table
whose row count grows with *distinct traffic shapes per hour*, not with
request volume — a gateway serving ten requests an hour and one serving ten
million produce the same number of rollup rows.

A background job keeps the rollup current by recomputing recent hour buckets
from a primary-key range scan. Its cost per tick is proportional to new
traffic, not to table size, so it stays flat as `request_logs` grows.

## 2. Non-goals

- **Percentile latency (p50/p95).** Percentiles are not additive; recovering
  them from buckets needs a mergeable sketch (t-digest), which needs a
  Postgres extension this project does not require. §7 stores sums, counts and
  a max, which give honest averages and a worst case. Revisit as its own
  change.
- **CSV export.** The tables render; nothing downloads.
- **Spend alerting.** `usage-counters` already enforces budgets at request
  time. This page reports, it does not act.
- **Per-request drill-down.** That is `/logs`, and the dashboard deep-links
  into it rather than reimplementing it.
- **A second rollup grain.** One hourly table. Daily and monthly views are
  `date_trunc` over it, not their own rows.
- **Rollups for non-`postgres` log stores.** The registry is built for forks to
  add drivers; only `postgres` ships. A fork running a write-only sink has no
  rows to aggregate and gets an explicit empty state, not a broken page.

## 3. Decisions

| Question | Decision |
|---|---|
| Aggregate shape | Incremental rollup table. Not a materialized view. |
| Grain | One hour. Coarser views are `date_trunc` over it. |
| Dimensions | hour, api key, user, model, provider, status class. |
| Freshness | ~60s. Job ticks every minute. |
| Maintenance | Recompute whole buckets, delete + reinsert. Never increment. |
| Late rows | Buckets stay open (`unsealed`) for 2 hours. |
| Bucket source | The uuid v7 `id` (request start), not `created_at`. |
| Concurrency | `pg_try_advisory_lock` on its own key, pinned client. |
| Rollup retention | Forever. Rollups outlive the partitions they came from. |
| Key deletion | No FK. Plain uuid + denormalized name. |
| Latency | Sums, counts and a max. No percentiles. |
| Unpriced requests | Counted in their own column. |
| Charts | shadcn `chart` (Recharts). |
| Placement | `/dashboard`, first nav item. `/` redirects there. |
| Backfill | Backwards from now, a day per tick, resumable. |

## 4. Why not a materialized view

The obvious reach is `CREATE MATERIALIZED VIEW … GROUP BY`, refreshed on a
timer. It is rejected, and the reason is the whole premise of this change.

A materialized view does store its rows physically, so *reads* never touch
`request_logs`. But Postgres has no incremental refresh: `REFRESH MATERIALIZED
VIEW` recomputes the entire view from the entire base table, every time.
The scan this design exists to avoid does not disappear — it moves off the
page load and onto a timer, and it grows forever. `CONCURRENTLY` requires a
unique index and roughly doubles the work.

Two further disqualifications:

- **A view cannot outlive its source.** `dropExpiredPartitions` deletes raw
  logs past the retention window. A view over `request_logs` loses that
  history on its next refresh. §9 keeps rollups forever, which a view makes
  impossible.
- **A view cannot be backfilled selectively or repaired incrementally.** It is
  all or nothing.

The second candidate — upserting the bucket from the request path, in the same
transaction as the log insert — is rejected for a different reason. It is
always exact and always fresh, but every concurrent request for the same
(hour, key, model) contends on **one row**, serialising the gateway's hottest
path behind a lock. It also cannot aggregate anything already logged.

What remains is a watermarked recompute job: §8.

## 5. The uuid v7 identity trick

`request_logs.id` is a uuid v7 minted at request start, and it is the primary
key. `uuidv7Bound(t)` returns the lowest uuid that can exist at instant `t`,
so `id >= uuidv7Bound(from) AND id < uuidv7Bound(to)` is a **time range
expressed as a primary-key range**. `src/lib/logs/postgres.ts:49` already uses
this for the log viewer's date filters.

Everything downstream follows from it. "Aggregate the last three hours" is a
PK range scan with partition pruning, not a sequential scan and not a second
index to maintain. This is why the job's cost tracks new traffic rather than
table size.

### 5.1 Extracting the hour in SQL

The job must `GROUP BY` the hour a request *started*, which means reading the
timestamp back out of the uuid. Postgres 18 has `uuid_extract_timestamp()`;
compose pins `postgres:17`, and `src/lib/uuid.ts` already generates ids in the
application for the same reason. So the job extracts it:

```sql
date_trunc(
  'hour',
  to_timestamp(
    ('x' || substring(replace(id::text, '-', '') from 1 for 12))::bit(48)::bigint / 1000.0
  ),
  'UTC'
)
```

The first 48 bits of a v7 uuid are a big-endian millisecond timestamp; the
first 12 hex characters of the dashless text form are exactly those bits.
`date_trunc(field, timestamptz, zone)` — three-argument form, Postgres 16+ —
truncates in UTC explicitly rather than in whatever the session's `TimeZone`
happens to be, so the same row cannot land in different buckets on different
connections.

This expression is defined once, as a named constant with this comment, and a
test round-trips it against `uuidv7Bound` across a DST boundary and a month
boundary. It is the kind of code that is either correct and boring forever or
subtly wrong in a way nobody notices until the numbers are questioned.

### 5.2 Why not bucket by `created_at`

`id` is the request's *start*; `created_at` is its *completion*. Bucketing by
`created_at` while selecting by an `id` range makes the two disagree at every
hour boundary: a stream starting 10:59 and finishing 11:04 is selected by hour
10's range and bucketed into hour 11, so the delete-and-reinsert in §8 would
delete a row it did not write and write a row outside the range it deleted.
Idempotency is gone.

Selecting by `created_at` instead trades that for a worse problem: `created_at`
is not the partition key, so a range on it prunes nothing and scans every
partition.

Bucketing by start also means the dashboard and `/logs` date filters mean the
same thing, which matters the first time someone cross-checks one against the
other.

## 6. Status class, not outcome

The rollup carries `status_class` (`success` / `client_error` / `server_error`),
derived exactly as `conditions()` in `src/lib/logs/postgres.ts:54-58` derives
it, so an error rate on the dashboard and a status filter on `/logs` agree. The
new `status_class` Postgres enum takes exactly the three values of the existing
`StatusClass` TS union in `src/lib/logs/types.ts`, so the two cannot drift.

`outcome` (`client_closed`, `stream_interrupted`) is deliberately not a
dimension. It multiplies rows for a distinction the dashboard does not group
by, and both values already carry a status that lands in one of the three
classes.

## 7. The table

```
usage_rollups
  bucket             timestamptz  NOT NULL   -- hour start, UTC
  api_key_id         uuid                    -- no FK; see §7.1
  key_name           text                    -- denormalized label
  user_id            uuid                    -- resolved via api_keys at rollup time
  user_name          text
  model              varchar(128)            -- as requested by the client
  provider           text                    -- final_provider
  status_class       status_class NOT NULL

  requests           integer      NOT NULL
  unpriced_requests  integer      NOT NULL   -- cost_usd IS NULL

  prompt_tokens      bigint       NOT NULL
  completion_tokens  bigint       NOT NULL
  cached_tokens      bigint       NOT NULL
  reasoning_tokens   bigint       NOT NULL

  input_cost_usd     numeric(18,9) NOT NULL
  cached_cost_usd    numeric(18,9) NOT NULL
  output_cost_usd    numeric(18,9) NOT NULL
  cost_usd           numeric(18,9) NOT NULL

  latency_sum_ms     bigint       NOT NULL
  latency_max_ms     integer      NOT NULL
  latency_count      integer      NOT NULL
  ttft_sum_ms        bigint       NOT NULL
  ttft_count         integer      NOT NULL
```

Indexes:

- `UNIQUE NULLS NOT DISTINCT (bucket, api_key_id, user_id, model, provider, status_class)`
- `(bucket)` — every query filters on it
- `(api_key_id, bucket)`, `(user_id, bucket)`, `(model, bucket)` — the filters

`numeric(18,9)` matches `request_logs` exactly. The scale-9 comment on
`request_logs.input_cost_usd` explains why: a sub-micro-dollar request rounded
to `0.000000` is a silent zero, and a rollup that quietly re-rounded what the
log rows carefully preserved would reintroduce the lie one layer up.

### 7.1 No foreign key on `api_key_id`

`request_logs` uses `ON DELETE SET NULL` with the comment "a deleted key must
not erase the history of what it did". That exact clause is a bug here.

`api_key_id` is part of a unique index. When a key is deleted and its rollup
rows are set to `NULL`, they collide with any other deleted key's rows for the
same (bucket, user, model, provider, status class) — and the delete fails on a
unique violation. Deleting an API key would start throwing, months after this
lands, for reasons nobody would connect to a dashboard.

`ON DELETE CASCADE` avoids the collision by destroying spend history, which
contradicts the rule `request_logs` states.

So: no foreign key. `api_key_id` is a plain uuid recording a historical fact,
`key_name` is denormalized beside it — the same move `request_logs.key_name`
already makes, one step further. The key selector on the dashboard reads live
keys from `api_keys`; rollups belonging to deleted keys still render, labelled
by their stored name.

`user_id` and `user_name` are resolved by `LEFT JOIN api_keys … LEFT JOIN
users` at rollup time and then frozen. Reassigning a key to a different user
therefore changes future buckets and leaves past ones alone, which is the
honest reading: those requests were made under the old owner.

### 7.2 `NULLS NOT DISTINCT`

`api_key_id`, `model` and `provider` are all nullable. Postgres treats two
NULLs as distinct in a unique index by default, so without this clause the
index would not constrain the rows that need it most, and duplicate buckets
would accumulate invisibly — inflating every total on the page. Requires
Postgres 15+; compose pins `postgres:17`.

### 7.3 `unpriced_requests`

`sum(cost_usd)` over requests the catalog could not price reads as "$0 spent".
The logs page already refuses that: it renders `unpriced` rather than a zero.
The dashboard needs the same escape hatch, so the count travels with the sum
and every cost figure can say "…across N unpriced requests" when it is not the
whole story.

Token sums treat an unmeasured count as zero, which is a real if smaller
version of the same problem. It is accepted rather than solved: null token
counts overwhelmingly coincide with failed requests, which are already
separated by `status_class`. Stated here so it is a decision and not an
oversight.

### 7.4 `latency_count` separate from `requests`

`ttft_ms` is null for non-streaming requests and `latency_ms` is
`NOT NULL`, so the two averages have different denominators. Storing one
`requests` count and dividing both by it would drag average TTFT toward zero
in proportion to how much non-streaming traffic there is.

## 8. The job

`src/lib/stats/rollup.ts`, started from `src/instrumentation.ts` beside
`startPartitionMaintenance()`, ticking every 60 seconds on an `unref`'d timer.

Per tick:

1. Take the advisory lock (§8.1). If it is held, return — another instance is
   doing this minute's work.
2. Read state from `settings` under `usage.rollup_state`.
3. Recompute the unsealed range (§8.2).
4. Advance `sealedThrough` to `currentHour - SEAL_LAG_HOURS`.
5. Do one chunk of backfill if any remains (§8.3).
6. Release the lock.

State is one `settings` row, the same pattern as `logs.last_maintenance`:

```json
{
  "sealedThrough": "2026-08-14T12:00:00.000Z",
  "backfilledTo": "2026-06-01T00:00:00.000Z",
  "oldestLog": "2026-05-28T09:00:00.000Z",
  "at": "2026-08-14T14:31:02.114Z"
}
```

A failure is logged and swallowed, never propagated — the same hierarchy of
concerns `startPartitionMaintenance` states: a reporting problem must not
become a serving problem.

### 8.1 The advisory lock

```ts
/** Arbitrary, stable, and unique to this job across everything talking to
 * this database. Deliberately not PARTITION_LOCK_KEY. */
export const ROLLUP_LOCK_KEY = BigInt(7_713_204_558_930_141)

const client = await pool.connect()
let unlockError: Error | undefined
try {
  const { rows } = await client.query(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked', [ROLLUP_LOCK_KEY.toString()],
  )
  if (!rows[0]?.locked) return null
  try {
    // recompute + backfill
  } finally {
    // pg_advisory_unlock; capture the error, do not rethrow it
  }
} finally {
  client.release(unlockError)
}
```

**A pinned client, not `db.execute()`.** `maintenance.ts:57-64` documents the
trap in full: `db` wraps a pool, so a bare execute checks out *some* idle
client per statement. The lock and its unlock can land on two different
backends; the unlock silently no-ops on a connection that never held the lock,
leaking it on the one that did. With `pg_try_advisory_lock`, every later tick
then finds it held and skips — forever, with nothing in the logs. Same trap,
same fix, and the unlock error is carried to `release()` so a client that may
still hold the lock is destroyed rather than recycled.

**`pg_try_advisory_lock`, not the blocking form.** `runLogMaintenance` blocks
on the boot path because a losing instance must not start serving with no
partitions provisioned. The opposite is right here: a losing tick means
another instance is already doing this minute's work, so it returns and the
next tick is 60 seconds away. Blocking would queue ticks behind each other,
and stack them without bound if one wedged.

**Its own key.** Sharing `PARTITION_LOCK_KEY` would make a per-minute job and a
daily job block each other for no reason.

**Why it matters here specifically.** The recompute is `DELETE` then
`INSERT … SELECT` over an hour range. Two instances interleaving inside that
window can have one's `DELETE` land after the other's `INSERT`, leaving those
hours permanently zeroed. The unique index cannot catch it — deleting rows
violates no constraint. The lock is what makes the recompute atomic *across
instances*; the transaction in §8.2 only makes it atomic within one.

### 8.2 Recompute, not increment

`SEAL_LAG_HOURS = 2`. Each tick recomputes
`[sealedThrough + 1h, currentHour + 1h)` — every hour not yet sealed, through
the current partial one — inside one transaction:

```sql
BEGIN;
DELETE FROM usage_rollups WHERE bucket >= $from AND bucket < $to;
INSERT INTO usage_rollups (...)
SELECT <hour expr> AS bucket,               -- 1
       rl.api_key_id,                       -- 2
       ak.user_id,                          -- 3
       rl.model,                            -- 4
       rl.final_provider,                   -- 5
       CASE WHEN rl.status < 400 THEN 'success'
            WHEN rl.status < 500 THEN 'client_error'
            ELSE 'server_error' END::status_class,   -- 6
       max(rl.key_name), max(u.name),       -- labels, not grain; see below
       count(*), count(*) FILTER (WHERE rl.cost_usd IS NULL),
       coalesce(sum(rl.prompt_tokens), 0), ...
       coalesce(sum(rl.latency_ms), 0), coalesce(max(rl.latency_ms), 0), count(rl.latency_ms),
       coalesce(sum(rl.ttft_ms), 0), count(rl.ttft_ms)
  FROM request_logs rl
  LEFT JOIN api_keys ak ON ak.id = rl.api_key_id
  LEFT JOIN users u ON u.id = ak.user_id
 WHERE rl.id >= $fromBound AND rl.id < $toBound
 GROUP BY 1, 2, 3, 4, 5, 6;
COMMIT;
```

**`key_name` and `user_name` are aggregated, not grouped.** They are labels
hanging off `api_key_id`, not part of the grain — and grouping by them would
be a live bug. `request_logs.key_name` is denormalized at write time, so
renaming a key mid-hour puts two different names on rows that share every
grain column. Grouping by the name emits two rows for one grain, and the
unique index of §7 rejects the second: the tick fails, and keeps failing for
two hours until that bucket seals. `max()` picks one name deterministically and
the grain stays six columns wide, exactly matching the index.

**Why recompute rather than `ON CONFLICT DO UPDATE SET x = x + excluded.x`.**
Incrementing is correct only if every row is counted exactly once — an
invariant nothing here provides. A retried tick, an overlapping range, a
partially-failed run: each double-counts, silently and permanently, with no
way to detect it after the fact and no way to repair it short of a full
rebuild. Recompute is idempotent: run the tick twice, or run it after a day of
downtime, and it converges on the same numbers. It also removes a combination
that *stopped* occurring, which an increment never does.

**The seal lag is what makes late rows work.** `id` is minted at request start
but the row is inserted at completion, so a stream starting 10:59 and
finishing 11:04 arrives after hour 10 was first computed. Hour 10 stays
unsealed for two more hours, so the next tick picks it up.

A request running longer than `SEAL_LAG_HOURS` is missed. That boundary is
asserted in a test rather than left implied, and two hours is chosen against a
gateway whose longest realistic request is a slow completion stream measured in
minutes.

**Chunking.** `MAX_HOURS_PER_TICK = 168` (a week) caps the range, so an
instance returning after a long outage catches up over several ticks instead
of in one enormous transaction. `sealedThrough` advances only as far as the
chunk actually covered, so the next tick resumes where this one stopped.

### 8.3 Backfill

`request_logs` already holds history when this ships. On the first tick,
`oldestLog` is read once (`SELECT min(id)`, a PK lookup) and `backfilledTo` is
initialised at the sealed point.

Each tick then aggregates one day, **walking backwards**, and moves
`backfilledTo` down until it passes `oldestLog`. Backwards because the most
recent history is the most useful: the dashboard's default 24h and 7d views
are populated within minutes of first boot, while 2024 fills in over the
following hours.

Backfill uses the same recompute path as §8.2 — the same delete-and-reinsert
over an hour range — so it is not a second implementation that can disagree
with the first. It resumes from `backfilledTo`, so an interrupted backfill
loses at most one day of progress.

While `backfilledTo > oldestLog`, the page shows a banner naming the earliest
aggregated date, so a total that is not yet complete never reads as one that
is.

## 9. Retention

Rollups are kept forever. Nothing drops them.

This is the payoff for a real table rather than a view. `dropExpiredPartitions`
deletes raw logs past the configured window; usage and spend history survives
it, and `/dashboard` answers "what did we spend last year" when `/logs` has
nothing left to show.

The growth is bounded by distinct traffic shapes, not by volume: one row per
hour per (key, model, provider, status class) that actually occurred. Fifty
live combinations is roughly 440,000 rows and well under 100 MB a year, on a
table that only ever gets range-scanned by `bucket`. If a deployment ever
outgrows that, a daily roll-up-of-the-rollup is an additive change; nothing
here forecloses it.

## 10. Read layer

`src/lib/stats/query.ts`. Three functions, all reading `usage_rollups` only.
None of them, on any path, touches `request_logs`.

- **`loadSummary(filter)`** — totals for the range and for the immediately
  preceding equal-length range, so the tiles show a delta.
- **`loadSeries(filter)`** — `GROUP BY date_trunc($grain, bucket), status_class`.
- **`loadBreakdown(filter, dimension)`** — top rows by cost for
  `model | key | user | provider`.

Grain is derived from the range rather than asked for: ≤ 2 days → hour,
≤ 90 days → day, beyond → month. One knob fewer, and a year-long range can
never render 8,760 points.

Averages are `sum / count` with a zero guard. Error rate is non-`success`
requests over total requests.

`src/lib/admin/dashboard.ts` turns URL search params into a filter, mirroring
`parseLogFilter`: every unrecognised value degrades to the default rather than
throwing, and uuid-shaped params are regex-checked before they can reach a
uuid column and raise `invalid input syntax for type uuid`.

## 11. The page

`/dashboard`, a server component, `force-dynamic`, laid out like `/logs`. It
becomes the first nav item, above the Providers group, and `src/app/page.tsx`
redirects there instead of `/providers`.

- **Filter bar** — range presets (24h / 7d / 30d / 90d / all) plus custom
  from/to, and API key, user and model selects.
- **Stat tiles** — Requests, Cost, Tokens in/out, Error rate, Avg latency, each
  with its delta against the previous equal-length period. The cost tile shows
  "N unpriced" whenever `unpriced_requests > 0`.
- **Charts** — requests over time stacked by status class, and cost over time.
  `pnpm dlx shadcn@latest add chart tabs`. The `dataviz` skill is loaded before
  any chart code is written.
- **Breakdowns** — tabbed tables for model / key / user / provider, sorted by
  cost descending, showing requests, tokens, cost and error rate.
- **View these requests** — deep-links to `/logs` carrying the equivalent
  filters. The dashboard answers *how much*; the log viewer stays the place for
  *which one*.

The model selector reads `SELECT DISTINCT model FROM usage_rollups` rather than
`virtual_models` as `/logs` does. `/logs` misses direct `provider/model`
addresses that way; sourcing from the rollup is cheap against a small table and
can only ever offer values that have data behind them.

### 11.1 States that are not "a grid of zeros"

- **No rollups yet** — no traffic, or the job has not ticked. Says which.
- **Backfill running** — banner naming the earliest aggregated date (§8.3).
- **Log store is not `postgres`** — explains that rollups come from the
  Postgres store and points at Settings, mirroring the "cannot be read back"
  state `/logs` already has.

## 12. Testing

Against the disposable Postgres on **5434**, never 5432. `.env.test` is copied
from `.env.test.example`.

Pure, no database:

- Hour arithmetic, seal window, and the unsealed range for a given `now`.
- Backfill cursor: first run, mid-run, and the run that finishes.
- Grain selection at each boundary.
- Search-param degradation, including a non-uuid `key`.

Against the database:

- Synthetic logs → tick → expected rollup rows.
- **The tick run twice produces identical rows.** Idempotency is the premise of
  §8.2; if this test does not exist, the premise is a claim.
- A row landing late but within the seal lag is picked up on the next tick.
- A row landing beyond the seal lag is missed — asserted deliberately, so the
  boundary in §8.2 is documented rather than discovered.
- The §5.1 hour expression round-trips against `uuidv7Bound`, across a DST
  boundary and a month boundary.
- Deleting an API key leaves its rollup rows intact and does not raise (§7.1).
- Two combinations differing only by a NULL `model` stay distinct rows (§7.2).
- A key renamed mid-hour produces **one** rollup row, not a unique violation
  (§8.2).
- Unpriced requests: cost sums to 0 and `unpriced_requests` is non-zero.
- Non-streaming requests do not drag average TTFT down (§7.4).

## 13. Files

New:

- `src/lib/stats/types.ts` — filter, row and view types
- `src/lib/stats/buckets.ts` — pure hour/seal/backfill arithmetic
- `src/lib/stats/rollup.ts` — the job, the lock, the recompute SQL
- `src/lib/stats/query.ts` — the three read queries
- `src/lib/admin/dashboard.ts` — search-param parsing, view loading
- `src/app/(admin)/dashboard/page.tsx`
- `src/app/(admin)/dashboard/dashboard-filters.tsx`
- `src/app/(admin)/dashboard/usage-charts.tsx`
- `src/components/ui/{chart,tabs}.tsx` — via the shadcn CLI
- `drizzle/0005_*.sql` — the table, the enum, the indexes

Changed:

- `src/lib/db/schema.ts` — `statusClassEnum`, `usageRollups`, `UsageRollupRow`
- `src/instrumentation.ts` — start the rollup job
- `src/app/(admin)/layout.tsx` — nav entry
- `src/app/page.tsx` — redirect target
- `README.md` — the dashboard, and that rollups outlive log retention

`src/lib/stats/`, not `src/lib/usage/`: `usage/` is the Redis-backed rate-limit
and budget counter store from `usage-counters`. It answers "may this request
proceed" in milliseconds on the hot path. This answers "what happened last
month" from Postgres, off the request path entirely. Same word, unrelated
concerns, and merging them would put a `server-only` Postgres aggregation
beside a driver that must stay swappable for an in-process `Map`.
