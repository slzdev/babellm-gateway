# Governance › Request Logs

Date: 2026-08-13
Status: approved, ready for planning

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

`LogRow` is the table's columns minus payloads; `LogDetail` is a `LogRow` plus
the payload row when one exists.

Two drivers ship:

| Driver | Readable | Notes |
|---|---|---|
| `postgres` | yes | Default. Writes `request_logs` (+ `request_payloads`). |
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
src/lib/logs/index.ts       logRequest() facade, re-exports
src/lib/pricing.ts          cost computation from the catalog
```

`src/lib/gateway/request-log.ts` is deleted; `tests/gateway/request-log.test.ts`
moves to `tests/lib/logs/line.test.ts` unchanged apart from its import.

## 4. Data model

### uuid v7

`postgres:17-alpine` is pinned in compose and native `uuidv7()` only arrives in
Postgres 18, so ids are generated app-side in `src/lib/uuid.ts`: a 48-bit
millisecond timestamp, 74 random bits, version and variant nibbles set. Wired
as `uuid('id').primaryKey().$defaultFn(uuidv7)`.

Time-ordered ids earn three things at once:

- Inserts append to the right edge of the B-tree instead of scattering across
  it, which is the difference between a log table that keeps up and one that
  does not.
- The primary key **is** the pagination index. Keyset paging is
  `WHERE id < $cursor ORDER BY id DESC`.
- A time-range filter becomes an id-range bound: `uuidv7Bound(date)` builds the
  uuid with that timestamp and zeroed random bits, so `id >= bound` is a range
  scan on the primary key. No `created_at` index is needed.

The tradeoff: with clocks skewed across instances, a row can land marginally
outside a boundary. At millisecond granularity, for a log viewer, that is
accepted.

Only `request_logs` uses v7. Existing tables keep `defaultRandom()`.

### `request_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | v7, app-generated |
| `request_id` | text | unique index; the `req_…` value also returned as `x-request-id` |
| `created_at` | timestamptz | default now() |
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

**Indexes** — three total:

- `(id)` — primary key; serves ordering, paging, time ranges, and pruning.
- `(api_key_id, id desc)` — filter by key.
- `(model, id desc)` — filter by model.

Three indexes on the most-written table in the system is the substance of the
scalability warning in §7, not a footnote to it.

### `request_payloads`

| Column | Type | Notes |
|---|---|---|
| `request_log_id` | uuid PK | → `request_logs`, **on delete cascade** |
| `request_json` | jsonb | |
| `response_json` | jsonb | nullable |
| `truncated` | boolean | not null, default false |

Cascade means pruning the log prunes its payload in the same statement.

A truncated JSON string is not valid JSON, so an oversized payload is not
stored clipped. It is replaced by a valid envelope:

```json
{ "truncated": true, "bytes": 91234, "preview": "…first N chars…" }
```

The column stays honestly typed as `jsonb`, and the UI parses one shape.

## 5. Configuration

Everything lives in the existing `settings` table. There is no
`REQUEST_LOG_STORE` environment variable: switching stores must not require a
redeploy.

| Key | Default | Meaning |
|---|---|---|
| `logs.store` | `postgres` | Driver name |
| `logs.retention_days` | `30` | `0` disables pruning |
| `logs.payload_max_bytes` | `262144` | 256 KiB |
| `logs.last_prune` | — | `{ at, deleted }`, written by the pruner |

Read and written through `getLoggingSettings` / `setLoggingSettings`, added
alongside the existing catalog pair in `src/lib/settings.ts`. That file is 57
lines; splitting it into a folder would churn three import sites for no benefit
yet.

### Resolution and caching

`getRequestLogStore()` reads the logging settings bundle, memoizes the resolved
driver instance, and re-instantiates when the configuration changes.

**The cache holds the whole bundle** — driver, retention days, payload cap —
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

`chat-handler.ts` keeps its shape. Its `log()` closure grows fields, and one
call becomes non-blocking:

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
the payload is replaced by the §4 envelope. Both rows then go in a single
transaction: capping has already happened, so the only remaining failure mode
is the database itself, and losing both rows together is the coherent outcome.
The detail view still handles a missing payload row defensively.

## 7. Read path and UI

### Navigation

`NAV` in `(admin)/layout.tsx` becomes a list of sections rather than links:
ungrouped entries first, then a `GOVERNANCE` group holding *Request Logs*, and
a *Settings* entry pinned at the bottom. `NavLink` is untouched; the layout
renders an optional section label above each group.

### Routes

Flat, matching `/models` and `/models/[id]`:

- `/logs` — the table
- `/logs/[requestId]` — the detail

A real page rather than a modal: the natural thing to do with a broken request
is paste its URL to someone else.

### Filters

Held in `searchParams` and read by the server component — shareable,
back-button-correct, no client state to synchronize.

- Time range — last 1h / 24h / 7d / 30d / all, defaulting to 24h
- API key — select over `api_keys`
- Model — combobox seeded from virtual model names, free text allowed so a
  `provider/model` route can be typed
- Status/outcome — one select: all, success, client error, server error,
  stream interrupted, client closed
- Request id — jumps straight to the detail page

Paging is keyset on the v7 primary key: `before` / `after` cursors in the URL,
"Newer" / "Older" rather than page numbers.

### Banners

The honest part of the feature.

- **Postgres driver** — a persistent warning on `/logs`: logs live in your
  application database; this is right for development and low traffic; at high
  request rates this table and its three indexes will dominate that database;
  switch stores on the Settings page when that day comes.
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
tab, holding the driver select (with the no-migration warning), retention days,
payload cap, and last-prune status. Future settings get their own tabs; the
catalog's registry settings stay where they are, on the catalog page — moving
them is separate work.

Needs `pnpm dlx shadcn@latest add tabs`. Everything else composes from what is
already installed.

Access control is unchanged: `requireAdmin()` in the `(admin)` layout covers
both pages.

## 8. Retention

`src/instrumentation.ts` exports `register()`, which Next calls once per server
instance. Guarded with `process.env.NEXT_RUNTIME === 'nodejs'` so it does not
also fire on the edge runtime.

An hourly interval:

1. Reads the current logging settings (cached, so nearly free). `0` retention
   days means skip.
2. Takes `pg_try_advisory_lock` on a fixed key; skips if another instance holds
   it. Exactly one instance prunes regardless of how many are running.
3. Calls `store.prune(cutoff)`, which for postgres deletes in batches of 5000
   with `id < uuidv7Bound(cutoff)` — a range scan on the primary key, with
   payloads following through the cascade.
4. Writes `logs.last_prune`.

`stdout.prune()` returns 0. The timer follows a driver switch without a
restart, because it resolves the store each tick.

## 9. Error handling

| Failure | Behavior |
|---|---|
| Store write fails | stderr, never reaches the client |
| Settings read fails | fall back to `stdout`, cache the fallback 15s |
| `logs.store` names no registered driver | fall back to `stdout`, banner on `/logs` |
| Store is not readable | type-level branch, explanatory empty state |
| `query()` fails | error state on the page, not a crash |
| Payload over cap | valid-JSON envelope, `truncated: true` |
| Prune lock held elsewhere | skip this tick |

The hierarchy throughout: a logging problem never becomes a serving problem.

## 10. Testing

Integration-first, matching the existing suite, which runs against a real
Postgres. `tests/helpers/db.ts` gains `request_logs` and `request_payloads` in
its `TRUNCATE` list.

**Unit**
- `uuidv7` — version and variant nibbles, ordering across milliseconds,
  `uuidv7Bound` correctness.
- Pricing — cached subtracted from prompt tokens; missing rate → `null` not
  `0`; cached falling back to the input rate; snapshot recorded.
- Payload capping — envelope shape, `truncated` flag, under-cap passthrough.
- `buildRequestLog` — the moved test, plus the new token/cost keys.

**Store contract** — one shared suite run against both drivers: `write`
resolves, `prune` returns a number, `readable` matches the driver's
capabilities.

**Postgres driver** — write → query → get roundtrip; each filter; keyset paging
in both directions; prune cascading to payloads; truncation of over-long model
names.

**Registry** — 15s cache serves from memory; a settings write clears the local
entry; an unknown driver name falls back to stdout; a failed settings read
falls back and caches.

**Gateway** — a row lands with correct fields for `ok`, `error`,
`stream_interrupted`, and `client_closed`; streaming usage captured from the
final chunk; `disableStreamUsage` leaves nulls; payload capture honors
`log_payloads` in both directions.

**Admin** — filter parsing from `searchParams`; the settings server action
validates and persists.

## 11. Consequences to document

- The README gains a Governance section: what the page shows, how to switch
  stores, and the Postgres scalability warning in prose.
- Existing deployments start writing logs to their database on upgrade, because
  `postgres` is the default. Selecting `stdout` on the Settings page restores
  exactly today's behavior.
- The stdout line gains token and cost keys. The change is additive, so
  existing log parsers keep working.
