# Governance › Request Logs

Date: 2026-08-13
Status: approved, ready for planning

Revised 2026-08-13, before any of it shipped: `request_logs` is partitioned by
month on its uuid v7 primary key, payloads are folded into the row rather than
kept in a second table, `request_id` is deleted in favour of the v7 id itself,
and retention becomes a drop-partition job measured in months. The sections
below describe the revised design; nothing here was ever applied to a real
database, so there is no migration path to preserve.

## 1. Goal

Give the gateway a durable, queryable record of every request it serves, and a
Governance section in the admin UI to read it. The store behind that record is
pluggable: operators choose where logs go, switch stores from the UI without a
redeploy, and are told plainly when their choice will not scale.

Today `emitRequestLog` writes one JSON line to stdout and nothing else. That
line survives unchanged as one of the two shipped drivers.

## 2. Non-goals

Budgets, rate limits, and spend enforcement. Log export or download. Full-text
search over payloads. Migrating existing rows when the store changes. Drivers
beyond `postgres` and `stdout` — the interface is the extension point, and a
third driver is a fork's one file, not this spec's work.

## 3. The store contract

Capability is expressed in the type, not enforced at runtime. A write-only
destination is a `RequestLogSink`; a destination the UI can read narrows to
`ReadableRequestLogStore` through the `readable` discriminant.

```ts
// src/lib/logs/types.ts

interface BaseSink {
  readonly name: string
  write(entry: RequestLogEntry): Promise<void>
  /**
   * Provision storage ahead of time and discard whatever has aged out.
   * A driver with no storage of its own returns an empty result.
   */
  maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult>
  /** Drain anything buffered. Called on shutdown. */
  flush?(): Promise<void>
}

export interface MaintenanceResult {
  /** Partition names created and dropped, for the status line in Settings. */
  created: string[]
  dropped: string[]
}

export interface WriteOnlySink extends BaseSink {
  readonly readable: false
}

export interface ReadableRequestLogStore extends BaseSink {
  readonly readable: true
  query(filter: LogFilter): Promise<LogPage>
  /** By primary key. Returns null for anything that is not a uuid. */
  get(id: string): Promise<LogDetail | null>
}

export type RequestLogStore = WriteOnlySink | ReadableRequestLogStore
```

A **discriminated union** rather than one interface with a boolean flag: `if
(store.readable)` narrows a union to the readable member, while a `boolean`
property on a single interface narrows nothing. That distinction is the whole
point — it gives the page either a typed store or a typed "this driver cannot
be read" branch, and a `query()` that throws in production is the failure this
shape exists to prevent.

`getRequestLogStore(): Promise<RequestLogStore>`.

The read types:

```ts
export interface LogFilter {
  from?: Date
  to?: Date
  apiKeyId?: string
  model?: string
  /** Status class, from the single UI select. */
  statusClass?: 'success' | 'client_error' | 'server_error'
  outcome?: RequestOutcome
  /** Keyset cursors — uuid v7 ids. */
  before?: string
  after?: string
  limit: number
}

export interface LogPage {
  rows: LogRow[]
  nextCursor: string | null
  prevCursor: string | null
}
```

`LogRow` is the table's columns minus the payload columns; `LogDetail` is a
`LogRow` plus those columns.

`maintain` rather than `prune` because retention is no longer a deletion. For
postgres it both creates future partitions and drops expired ones, and those
two halves cannot be split: a driver that only dropped would eventually have
nothing left to write into. Returning the names touched, rather than a row
count, matches what the operation actually knows — dropping a partition never
counts the rows inside it.

Two drivers ship:

| Driver | Readable | Notes |
|---|---|---|
| `postgres` | yes | Default. Writes `request_logs`, partitioned by month. |
| `stdout` | no | Today's JSON line, byte-for-byte plus the new token/cost keys. |

### Module layout

`src/lib/gateway/request-log.ts` is split, because a stdout driver importing
the gateway module that imports the driver registry would be a cycle:

```
src/lib/logs/types.ts       entry, filter, page, detail, sink/store interfaces
src/lib/logs/line.ts        buildRequestLog() — moved verbatim, gains fields
src/lib/logs/stdout.ts      stdout driver (imports line.ts)
src/lib/logs/postgres.ts    postgres driver
src/lib/logs/registry.ts    driver table + getRequestLogStore() + settings cache
src/lib/logs/partitions.ts  month arithmetic, create/drop, the maintenance job
src/lib/logs/index.ts       logRequest() facade, re-exports
src/lib/pricing.ts          cost computation from the catalog
```

`src/lib/gateway/request-log.ts` is deleted; `tests/gateway/request-log.test.ts`
moves to `tests/lib/logs/line.test.ts` unchanged apart from its import.

## 4. Data model

### uuid v7

`postgres:17-alpine` is pinned in compose and native `uuidv7()` only arrives in
Postgres 18, so ids are generated app-side in `src/lib/uuid.ts`: a 48-bit
millisecond timestamp, 74 random bits, version and variant nibbles set.

The id is generated **at the start of the request**, in `chat-handler.ts`, not
by a column default at insert. It is the request's single identifier for its
whole life: returned as `x-request-id`, echoed in `attemptHeaders`, printed on
the stdout line, stored as the primary key, and used as the detail-page URL.
There is no separate `request_id`.

Time-ordered ids earn four things at once:

- Inserts append to the right edge of the B-tree instead of scattering across
  it, which is the difference between a log table that keeps up and one that
  does not.
- The primary key **is** the pagination index. Keyset paging is
  `WHERE id < $cursor ORDER BY id DESC`.
- A time-range filter becomes an id-range bound: `uuidv7Bound(date)` builds the
  uuid with that timestamp and zeroed random bits, so `id >= bound` is a range
  scan on the primary key. No `created_at` index is needed.
- It is the **partition key**. Postgres compares `uuid` byte-wise and v7 leads
  with a big-endian millisecond timestamp, so uuid order is time order and a
  month boundary is expressible as a plain uuid bound. `uuidv7Bound` — written
  for the time filter — is exactly the partition-bound generator.

Two consequences follow from generating at request start and must be stated
rather than discovered:

- `id` encodes when the request **began**; `created_at` records when it
  **finished**. Ordering by `id DESC` is therefore most-recently-started. For a
  log viewer this is the more useful order, and it is the only one available
  since the partition must be chosen from the id.
- A request that starts at 23:59:59 on the last day of a month and finishes
  after midnight is filed in the month it started in. At the default
  `retentionMonths: 3` that partition survives for months, but this is not
  guaranteed in general: at `retentionMonths: 1`, `keepFrom` is the current
  month, so the outgoing month's partition can be dropped by the first
  maintenance run on or after the 1st — and if this request's insert happens
  after that drop, its log line is lost rather than filed.

The tradeoff: with clocks skewed across instances, a row can land marginally
outside a boundary — including a partition boundary. At millisecond
granularity, for a log viewer, that is accepted.

Only `request_logs` uses v7. Existing tables keep `defaultRandom()`.

### `request_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | v7, generated at request start; also the partition key and `x-request-id` |
| `created_at` | timestamptz | default now() — completion time |
| `api_key_id` | uuid | → `api_keys`, **on delete set null** |
| `key_name` | text | denormalized; survives rename and deletion |
| `model` | varchar(128) | what the client asked for — virtual name or `provider/model` |
| `stream` | boolean | |
| `status` | integer | |
| `outcome` | `request_outcome` enum | `ok` / `error` / `client_closed` / `stream_interrupted` |
| `error_type` | text | nullable |
| `error_code` | text | nullable |
| `error_message` | text | nullable |
| `latency_ms` | integer | |
| `ttft_ms` | integer | nullable, streaming only |
| `attempts` | jsonb | `AttemptRecord[]` verbatim, `target_id` included |
| `final_target_id` | uuid | nullable, no FK — targets are deleted freely |
| `final_provider_id` | uuid | nullable |
| `final_provider` | text | denormalized |
| `final_upstream_model` | varchar(128) | denormalized |
| `prompt_tokens` | integer | nullable |
| `completion_tokens` | integer | nullable |
| `cached_tokens` | integer | nullable |
| `reasoning_tokens` | integer | nullable |
| `input_cost_usd` | numeric(18,9) | nullable |
| `cached_cost_usd` | numeric(18,9) | nullable |
| `output_cost_usd` | numeric(18,9) | nullable |
| `cost_usd` | numeric(18,9) | nullable — total |
| `pricing` | jsonb | nullable — the per-Mtok rates actually used |
| `dropped_params` | jsonb | nullable |
| `payload_captured` | boolean | not null, default false |
| `request_json` | jsonb | nullable — the captured request body |
| `response_json` | jsonb | nullable — what the client actually received |
| `payload_truncated` | boolean | not null, default false |

There is no `virtual_model_id`. `resolveModel` also serves direct
`provider/model` addresses, where `ResolvedModel.model.id` is a **catalog row
id**; a foreign key there would point at the wrong table. The denormalized
`model` string is what history should keep anyway, for the same reason
`key_name` is kept — and it makes the model filter work identically for both
routing kinds.

`varchar(128)` values (`model`, `final_upstream_model`) are **truncated at
write time**. An absurd model name in a request must not become a failed
insert that loses the log line.

Money is `numeric(18,9)`, not `(12,6)`: a small request can genuinely cost less
than a micro-dollar, and scale-6 would round it to `0.000000` — the silent-zero
lie in a different disguise. Catalog prices stay `(12,6)` per Mtok, the unit
they are quoted in.

Every cost column is `null` when the catalog cannot price the request. Null
renders as *unpriced*. Never `0`.

**Indexes** — three total, all declared on the partitioned parent so every
partition created later inherits them automatically:

- `(id)` — primary key; serves ordering, paging, time ranges, and detail lookup.
- `(api_key_id, id desc)` — filter by key.
- `(model, id desc)` — filter by model.

Three indexes on the most-written table in the system is the substance of the
scalability warning in §7, not a footnote to it. Partitioning is what keeps each
of them bounded: they are per-partition, so an index only ever spans one month.

There is **no unique index on anything but `id`**. Postgres requires every
unique constraint on a partitioned table to contain the partition key, which is
precisely why `request_id` was removed rather than kept alongside the v7 id.

The foreign key to `api_keys` survives partitioning unchanged: an outbound
reference from a partitioned table is enforced per-partition, `on delete set
null` propagates across partitions, and — unlike an *inbound* reference — it
does not block dropping one.

### Payloads live in the row

There is no `request_payloads` table. The three payload columns sit in
`request_logs` itself.

The second table existed to keep large bodies out of the way of the list query.
It does not earn its keep: Postgres gives every partition its own TOAST
relation, so an oversized `jsonb` is already stored out of line and is only
read when the column is selected — and `LIST_COLUMNS` never selects it. What
the separate table *did* add was a foreign key pointing **at** `request_logs`,
and an inbound foreign key makes a partition undroppable — which would defeat
the entire point of partitioning. Co-partitioning the payload table does not
help; the constraint depends on each referenced partition individually.

Folding the columns in also removes the two-row transaction from the write path
and the `leftJoin` from the read path.

A truncated JSON string is not valid JSON, so an oversized payload is not
stored clipped. It is replaced by a valid envelope:

```json
{ "truncated": true, "bytes": 91234, "preview": "…first N chars…" }
```

The column stays honestly typed as `jsonb`, and the UI parses one shape.

### Partitioning

`request_logs` is `PARTITION BY RANGE (id)`. Partitions are named
`request_logs_YYYY_MM` and bounded by `uuidv7Bound(startOfMonth)`.

**Months are UTC.** Not the server's local zone, which would make partition
boundaries move with a deployment's timezone and make the same row belong to
different months on different instances.

There is **no `DEFAULT` partition.** It would be a safety net for a row whose
month was never provisioned, but it is a trap: once a row lands in `DEFAULT`,
creating that month's partition fails until the row is drained out, and rows
stranded there escape retention entirely. The defence is provisioning instead —
the maintenance job in §8 keeps three months of partitions ahead of the present,
so reaching an unprovisioned month requires the job to have been failing for a
full quarter.

The migration creates the parent table and its indexes only. Every partition is
created by the maintenance job, so the month arithmetic has exactly one
implementation and it is in TypeScript, not duplicated in SQL.

What partitioning buys:

- Retention becomes `DROP TABLE`: constant time, no dead tuples, no vacuum debt.
  The alternative is a `DELETE` over the oldest rows of the largest table in the
  system, every day, forever.
- Every index stays one month wide.
- The existing filters prune partitions for free. `conditions()` already bounds
  `id` with `uuidv7Bound` for time ranges and with the cursor for paging, so a
  time-filtered query touches only the months in range. No query changes.

## 5. Configuration

Everything lives in the existing `settings` table. There is no
`REQUEST_LOG_STORE` environment variable: switching stores must not require a
redeploy.

| Key | Default | Meaning |
|---|---|---|
| `logs.store` | `postgres` | Driver name |
| `logs.retention_months` | `3` | `0` keeps everything |
| `logs.payload_max_bytes` | `262144` | 256 KiB |
| `logs.last_maintenance` | — | `{ at, created, dropped }`, written by the job |

Retention is measured in **months**, not days, because a monthly partition can
only be discarded whole. A day-granular setting would either lie — `30` keeping
up to 60 days of prompt content — or require keeping a row-level `DELETE` path
alongside the drops purely to honour the last few days. Months are what the
storage layout can actually express, so that is what the setting says.

`retention_months: N` keeps the current month and the `N - 1` preceding it.
`1` is the current month alone; `0` keeps everything, matching the existing
convention for a disabled retention setting.

Read and written through `getLoggingSettings` / `setLoggingSettings`, added
alongside the existing catalog pair in `src/lib/settings.ts`. That file is 57
lines; splitting it into a folder would churn three import sites for no benefit
yet.

### Resolution and caching

`getRequestLogStore()` reads the logging settings bundle, memoizes the resolved
driver instance, and re-instantiates when the configuration changes.

**The cache holds the whole bundle** — driver, retention months, payload cap —
for `LOG_SETTINGS_TTL_MS = 15_000`, declared as a named constant. In the steady
state the request path reads zero rows for logging. Caching only the driver
name would trade one query per request for two.

- A **failed settings read caches its fallback for the same 15s.** A database
  hiccup must not turn the cheapest path in the request into a retry storm.
- The instance that handles a settings write **clears its own entry
  immediately**, so the admin who just changed the setting sees it on reload.
  Other instances converge within 15s. The UI states this; it is not buried in
  docs.

Validation is by construction: the settings form offers a select over the
registered driver names, so an unknown value cannot be written.

### Switching stores

Switching does not migrate history. The previous store keeps its rows; the page
shows the new one only. The driver select carries that as an inline warning —
someone flipping `postgres` → `stdout` on a hunch should see that the table
they were reading is about to vanish from the UI, and that flipping back
restores it.

Driver **credentials**, the day a driver has any, belong in the database too,
encrypted through the existing `src/lib/crypto.ts` envelope that already
protects provider credentials, under `logs.store_config`. Stated now so a
future contributor does not put an API token in plaintext jsonb.

## 6. Write path

`chat-handler.ts` keeps its shape. It opens by minting the request's id —

```ts
const requestId = uuidv7()
```

— replacing the `newCompletionId().replace('chatcmpl-', 'req_')` line. That
value is the header, the log key, and the primary key. The OpenAI-compatible
response body still carries its own `chatcmpl-…` id from `newCompletionId()`;
the two are unrelated and stay that way.

Its `log()` closure grows fields, and one call becomes non-blocking:

```ts
void logRequest(entry).catch((err) =>
  console.error(`[gateway] failed to write request log request_id=${requestId}`, err))
```

`logRequest` resolves the driver and never throws. A request that succeeded is
not failed by its own bookkeeping — a promise `emitRequestLog` already makes,
carried over verbatim.

### Usage

**Non-streaming.** `result.value.usage` is already in hand: `prompt_tokens`,
`completion_tokens`, `prompt_tokens_details.cached_tokens`,
`completion_tokens_details.reasoning_tokens`.

**Streaming.** `sseResponse`'s `onSettle(outcome)` becomes
`onSettle(outcome, captured)`. The `for await` loop that already rewrites each
chunk also accumulates `chunk.usage` when it appears — which it does on the
final chunk, because `stream_options.include_usage` is already sent. A provider
configured with `disableStreamUsage` yields no usage and the columns stay
`null`. Never `0`: "we did not measure it" and "it was free" must not render
identically.

### Cost

`src/lib/pricing.ts` looks up `catalog_models` by
`(final_provider_id, final_upstream_model)` — the unique index that table
already carries — and returns the four amounts plus the `pricing` snapshot.

- Cached tokens are **subtracted from prompt tokens** before pricing. OpenAI
  reports the cached count as a subset of `prompt_tokens`; pricing both in full
  would overcount every cached request.
- A missing `cached_input_per_mtok` falls back to the input rate.
- No catalog row, or a row without input/output rates, yields `null` throughout.

Rates are memoized in-process with a short TTL (60s). A per-request catalog
query on the hot path would be a self-inflicted wound; a price edited in the
catalog UI taking effect within a minute is the right trade for a number that
changes monthly at most.

The `pricing` snapshot exists because editing a catalog price later would
otherwise make every historical row's arithmetic unexplainable.

### Payloads

Gated on `apiKey.logPayloads`, already returned on the `ApiKeyRow` by
`resolveApiKey`.

- Request payload: the validated body.
- Response payload: what the client **actually received** — post
  `rewriteCompletion` — because that is what someone is looking at when they
  open the detail view.
- Streams: assembled from content deltas into a synthetic completion. Raw chunk
  arrays are storage-hungry and nobody reads them. Assembly runs only when
  capture is on for that key, so every other stream pays nothing.
- A request that dies before parsing (malformed JSON, `401`) has no body. The
  log row is still written; `payload_captured` stays false.

Serialization and the size check happen **before** the insert. Over the cap,
the payload is replaced by the §4 envelope. The write is then a **single
`INSERT`** — the payload columns are part of the row. The transaction that
previously wrapped two inserts is gone, and with it the case where a log row
could exist without the payload row its `payload_captured` flag promised.

## 7. Read path and UI

### Navigation

`NAV` in `(admin)/layout.tsx` becomes a list of sections rather than links:
ungrouped entries first, then a `GOVERNANCE` group holding *Request Logs*, and
a *Settings* entry pinned at the bottom. `NavLink` is untouched; the layout
renders an optional section label above each group.

### Routes

Flat, matching `/models` and `/models/[id]`:

- `/logs` — the table
- `/logs/[id]` — the detail, keyed by the v7 id

A real page rather than a modal: the natural thing to do with a broken request
is paste its URL to someone else. Because the id in the URL is the same value
the client received as `x-request-id`, a user reporting a failure hands over
something that resolves directly to a page — and to a single partition, since
the id is the partition key.

`get()` validates the uuid shape before querying. An unparseable id would
otherwise reach Postgres and throw; it renders `notFound()` instead.

### Filters

Held in `searchParams` and read by the server component — shareable,
back-button-correct, no client state to synchronize.

- Time range — last 1h / 24h / 7d / 30d / all, defaulting to 24h
- API key — select over `api_keys`
- Model — combobox seeded from virtual model names, free text allowed so a
  `provider/model` route can be typed
- Status/outcome — one select: all, success, client error, server error,
  stream interrupted, client closed
- Request id — the v7 uuid; jumps straight to the detail page

Paging is keyset on the v7 primary key: `before` / `after` cursors in the URL,
"Newer" / "Older" rather than page numbers.

### Banners

The honest part of the feature.

- **Postgres driver** — a persistent warning on `/logs`: logs live in your
  application database; this is right for development and low traffic; at high
  request rates this table and its three indexes will dominate that database;
  switch stores on the Settings page when that day comes. Monthly partitioning
  bounds each index to one month's writes and makes retention a `DROP`, which
  moves that day considerably further out — it does not remove it, and the
  banner does not claim otherwise.
- **stdout driver** — the store narrows to `readable: false`, so the page
  renders an explanatory empty state instead of a table: where the logs went,
  and the `docker compose logs` + `x-request-id` grep the README already
  documents.
- **Unknown driver name** — a banner saying which name was configured, that
  logging has fallen back to stdout, and that an upgrade may be needed.

### Detail page

Header (request id, time, key, model, status and outcome badges, latency,
TTFT); the cost breakdown as input / cached / output / total with the `pricing`
snapshot shown as the rates used; a token row; the **attempt timeline** (n,
provider, upstream model, status, latency, error) — the actual payoff for
failover debugging; dropped params; and the payloads in `collapsible` blocks
with a truncation notice when the envelope is present.

### Settings page

New `/settings` route with tabs, tab held in `?tab=`. Governance is the first
tab, holding the driver select (with the no-migration warning), retention
months, payload cap, and last-maintenance status — the timestamp plus what was
created and dropped. Future settings get their own tabs; the
catalog's registry settings stay where they are, on the catalog page — moving
them is separate work.

Needs `pnpm dlx shadcn@latest add tabs`. Everything else composes from what is
already installed.

Access control is unchanged: `requireAdmin()` in the `(admin)` layout covers
both pages.

## 8. Partition maintenance and retention

Retention and provisioning are the same job, because they are the same
operation on the same objects: one creates partitions at the leading edge, the
other drops them at the trailing edge.

`src/lib/logs/partitions.ts` holds the month arithmetic as pure, directly
testable functions — `monthStart(date)` (UTC), `partitionName(date)` →
`request_logs_2026_08`, and `monthBound(date)` → `uuidv7Bound(monthStart(date))`
— and three operations over them.

**`ensurePartitions(client, now)`** creates the current month and the next
three, `CREATE TABLE IF NOT EXISTS … PARTITION OF`, which is idempotent. Three
months of lead is the entire defence against an unprovisioned month, since
there is no `DEFAULT` partition to catch one; it means the job must fail
continuously for a quarter, through every boot and every daily tick, before a
write can find no home.

**`dropExpiredPartitions(client, now, retentionMonths)`** enumerates the
partitions that actually exist, via `pg_inherits` joined to `pg_class`, rather
than deleting a computed list of names. The catalog is the truth: a partition
left by an older naming scheme, or made by hand, is visible this way and
invisible the other. It drops those whose month falls outside the keep window
and skips anything whose name does not parse as `request_logs_YYYY_MM`.
`retentionMonths: 0` skips the drop half entirely and keeps provisioning.

`src/lib/logs/maintenance.ts` — `retention.ts` renamed, since retention is no
longer what it does — owns the job itself. **`runLogMaintenance(now)`** resolves
the settings, calls `maintain` on every registered driver, and writes
`logs.last_maintenance`, all under `pg_try_advisory_lock` on a new
`PARTITION_LOCK_KEY`, distinct from the migration runner's key. The lock is
taken and released on **one client checked out from the pool**, not through
`db`: an advisory lock belongs to the session that took it, and a bare
`db.execute()` may lock on one pooled backend and unlock on another, leaking
the lock on the first and making every later run skip forever. The client is
released with the unlock error when one occurs, so a connection that may still
hold the lock is destroyed rather than recycled.

Each `CREATE` and `DROP` takes a brief `AccessExclusiveLock` on the parent
table, which blocks writes for its duration. On an empty new partition that is
sub-millisecond — but it is the reason partitions are provisioned months ahead
by a background job and never created on the insert path.

### Scheduling

`src/instrumentation.ts` exports `register()`, which Next calls once per server
instance. Guarded with `process.env.NEXT_RUNTIME === 'nodejs'` so it does not
also fire on the edge runtime.

`startPartitionMaintenance()` replaces `startRetentionTimer()`:

1. **At boot, awaited**, before the instance serves anything. With no `DEFAULT`
   partition, a database whose partitions do not exist yet cannot accept a log
   write, so this runs to completion first. A fresh install is provisioned by
   this run.
2. Then every **24 hours** on an `unref()`'d interval, so the timer never holds
   the process open. Idempotent, because Next may evaluate a module more than
   once in development.
3. Each run resolves the store (cached, so nearly free), so it follows a driver
   switch without a restart, and maintains **every registered driver**, not
   only the configured one — switching stores must not silently strand
   retention on data that still exists.
4. Writes `logs.last_maintenance`.

A boot run that fails **logs loudly and does not stop the server**. A logging
problem never becomes a serving problem — but the operator has to be able to
find out, because the consequence is silently discarded log lines rather than a
degraded page.

`stdout.maintain()` returns empty arrays.

## 9. Error handling

| Failure | Behavior |
|---|---|
| Store write fails | stderr, never reaches the client |
| Settings read fails | fall back to `stdout`, cache the fallback 15s |
| `logs.store` names no registered driver | fall back to `stdout`, banner on `/logs` |
| Store is not readable | type-level branch, explanatory empty state |
| `query()` fails | error state on the page, not a crash |
| Payload over cap | valid-JSON envelope, `truncated: true` |
| Maintenance lock held elsewhere | skip this tick |
| Boot maintenance fails | loud stderr, server still starts and serves |
| No partition for the row's month | insert fails, stderr, request unaffected |
| Detail id is not a uuid | `null` from `get()`, `notFound()` on the page |

The hierarchy throughout: a logging problem never becomes a serving problem.

## 10. Testing

Integration-first, matching the existing suite, which runs against the
disposable Postgres on **port 5434** — never the development database on 5432.

`tests/helpers/db.ts` gains `request_logs` in its `TRUNCATE` list. `TRUNCATE`
on the partitioned parent cascades to its partitions, so no per-partition
bookkeeping is needed — but the helper must also **provision partitions** for
whatever `now` a test uses, since there is no `DEFAULT` to absorb a write into.

**Unit**
- `uuidv7` — version and variant nibbles, ordering across milliseconds,
  `uuidv7Bound` correctness.
- Partition arithmetic — `monthStart` in UTC across a DST boundary and a
  year boundary; `partitionName` formatting; `monthBound` agreeing with
  `uuidv7Bound`; the keep-window computation for `retentionMonths` of 0, 1,
  and 3, including December→January.
- Pricing — cached subtracted from prompt tokens; missing rate → `null` not
  `0`; cached falling back to the input rate; snapshot recorded.
- Payload capping — envelope shape, `truncated` flag, under-cap passthrough.
- `buildRequestLog` — the moved test, plus the new token/cost keys.

**Store contract** — one shared suite run against both drivers: `write`
resolves, `maintain` returns a `MaintenanceResult`, `readable` matches the
driver's capabilities.

**Partition maintenance** (against real Postgres) — `ensurePartitions` creates
four months and is idempotent on a second call; a row inserted for each month
lands in the expected partition, asserted via `tableoid::regclass`;
`dropExpiredPartitions` removes exactly the months outside the keep window and
leaves the rest; `retentionMonths: 0` drops nothing; a partition whose name
does not parse is left alone; a second concurrent `maintainPartitions` skips
while the lock is held, and the lock is released afterwards so the next call
proceeds.

**Postgres driver** — write → query → get roundtrip; each filter; keyset paging
in both directions across a partition boundary; `get()` on a malformed id
returns `null`; payloads round-trip in the same row; truncation of over-long
model names.

**Registry** — 15s cache serves from memory; a settings write clears the local
entry; an unknown driver name falls back to stdout; a failed settings read
falls back and caches.

**Gateway** — a row lands with correct fields for `ok`, `error`,
`stream_interrupted`, and `client_closed`; streaming usage captured from the
final chunk; `disableStreamUsage` leaves nulls; payload capture honors
`log_payloads` in both directions; the `x-request-id` returned to the client is
a v7 uuid and equals the primary key of the row that was written.

**Admin** — filter parsing from `searchParams`; the settings server action
validates and persists.

## 11. Consequences to document

- The README gains a Governance section: what the page shows, how to switch
  stores, retention measured in months, and the Postgres scalability warning in
  prose.
- Existing deployments start writing logs to their database on upgrade, because
  `postgres` is the default. Selecting `stdout` on the Settings page restores
  exactly today's behavior.
- **`x-request-id` changes format**, from `req_…` to a v7 uuid. Nothing has
  shipped that returns the old form, so this breaks no deployed client, but it
  is the one client-visible change in this revision and belongs in the README
  next to the `docker compose logs` grep it documents.
- The stdout line gains token and cost keys, and its `request_id` value becomes
  the uuid. The added keys are additive; the changed value is not, so anything
  grepping for `req_` needs updating.
- Retention is expressed in months and is coarse by construction: the current
  month is always retained in full, however young it is. An operator who needs
  day-granular deletion of prompt content is not served by this design, and the
  Governance copy says so rather than implying otherwise.
- `drizzle-kit` cannot express `PARTITION BY`. Migration `0003` is hand-written
  SQL, and `drizzle-kit generate` may propose spurious diffs against the
  partitioned table; the schema file remains the source of truth for types, not
  for DDL.
