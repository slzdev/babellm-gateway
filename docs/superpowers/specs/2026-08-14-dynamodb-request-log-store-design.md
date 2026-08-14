# DynamoDB request log store — design

**Date:** 2026-08-14
**Status:** approved, ready for planning

## Purpose

Add `dynamodb` as a second `RequestLogStore` driver alongside `postgres`, readable
from the `/logs` dashboard.

The motivation is write volume and cost. Request logs outgrow what belongs in the
operational Postgres — partition maintenance, disk, vacuum pressure — and retaining
months of payload-carrying rows there is expensive for data that is written
constantly and read rarely.

That motivation decides the shape of the design more than anything else in this
document: **writes are the volume, reads are the exception.** Every trade-off below
pays on the read side.

## Scope

In scope: one new driver module implementing `ReadableRequestLogStore`, its
registration, configuration, tests, and docs.

Out of scope:

- Postgres remains the store for everything else. The registry reads `logs.store`
  from Postgres to find the driver at all, so settings, API keys, providers, and
  usage counters are untouched.
- No migration of existing Postgres logs into DynamoDB. Switching stores means new
  writes land in the new store; the old data ages out under its own retention.
- No S3 payload offload (see Rejected alternatives).

## Key schema

```
Table: <DYNAMODB_LOGS_TABLE>
  pk  (S, HASH)   "log#<0-f>"   — the id's last hex digit
  sk  (S, RANGE)  the uuid v7 id
  TTL attribute: expiresAt
  BillingMode: PAY_PER_REQUEST
  No GSIs, no LSIs
```

A uuid v7 sorts lexicographically in timestamp order, so **the sort key is the
clock**. A time range is a sort-key condition rather than a lookup:

```
sk BETWEEN uuidv7Bound(from) AND uuidv7Bound(to)
```

Three properties follow, and together they are why this schema was chosen:

1. **`get(id)` is a single `GetItem`.** The shard is derivable from the id alone —
   `rand_b` is random, so the last hex character is uniform over 0–f. No index, no
   lookup table.
2. **Cursors stay plain uuids.** The merged result is globally ordered by id, so
   resuming a page means `sk < cursor` in *every* shard. There is no per-shard
   `LastEvaluatedKey` to encode into the cursor, which means `LogFilter`, `LogPage`,
   and all of `src/lib/admin/logs.ts` need **no changes**.
3. **No empty-range walking.** A `range=all` query costs the same fan-out as a
   `range=1h` one.

Sixteen shards spread writes across sixteen partition keys, lifting the ~1000 WCU
per-key ceiling to ~16k.

### The shard count is immutable

`get()` derives the shard from the id. Changing 16 later makes every existing item
unreachable by detail lookup, silently — the list view would still show rows whose
detail page 404s.

`SHARDS = 16` is therefore a hard-coded constant with a comment saying exactly this.
It must never become an environment variable or a setting.

## Item shape

| Attribute | Type | Notes |
|---|---|---|
| `pk` | S | `log#<0-f>` |
| `sk` | S | the uuid v7 `id` |
| `expiresAt` | N | epoch **seconds**; the table's TTL attribute. Omitted when retention is 0. |
| `createdAt` | N | epoch **ms**, stamped with `new Date()` at write |
| `apiKeyId`, `keyName`, `model` | S | |
| `stream` | BOOL | |
| `status`, `latencyMs`, `ttftMs` | N | |
| `outcome` | S | |
| `errorType`, `errorCode`, `errorMessage` | S | |
| `finalTargetId`, `finalProviderId`, `finalProvider`, `finalUpstreamModel` | S | |
| `promptTokens`, `completionTokens`, `cachedTokens`, `reasoningTokens` | N | |
| `inputCostUsd`, `cachedCostUsd`, `outputCostUsd`, `costUsd` | **S** | numeric strings |
| `pricing` | M | small, fixed shape |
| `attempts` | L | small, fixed shape |
| `droppedParams` | L | |
| `payloadCaptured` | BOOL | |
| `payloadTruncated` | BOOL | |
| `requestJson`, `responseJson` | **S** | `JSON.stringify`'d |

Four decisions encoded in that table:

**Costs are strings, not numbers.** `LogRow.costUsd` is already `string | null`
because the Postgres columns are `numeric(18, 9)`. A DynamoDB `N` would round them.

**Payloads are JSON strings, not native maps.** They are arbitrary user content.
Native storage would hit DynamoDB's 32-level nesting limit and silently round any
float beyond 38 digits of precision. A string sidesteps both and is smaller.
`get()` parses it back. `attempts`, `pricing`, and `droppedParams` stay native —
they are small, fixed-shape, and not user-controlled.

**Null attributes are omitted entirely.** A typical entry carries a dozen nulls
(`errorType`, `ttftMs`, `pricing`, `droppedParams`, …). DynamoDB is schemaless, so
an absent attribute costs zero bytes and zero write units.

> The read mappers must therefore default every missing attribute back to `null`
> (and `attempts` to `[]`). This is the invariant most likely to be got wrong, and
> the one to test hardest.

**`id` has no attribute of its own.** It is stored once, as `sk`; the read mappers
map it back to `id`. Storing it twice would add ~40 bytes per item to duplicate the
sort key.

**Attribute names match the TypeScript field names.** Names are billed per item, and
shortening them to `s`/`l`/`t` would save roughly 10% — not worth items that cannot
be read in the AWS console while debugging a write bug.

**Model clamping is preserved.** DynamoDB has no column length limit, but
`postgresStore` clamps `model` and `finalUpstreamModel` to 128 characters. The
DynamoDB driver applies the same clamp, so `filter.model` equality matching behaves
identically across drivers.

## Write path

### Contract change: `write` receives settings

TTL must be stamped on the item at write time, but the current signature has no
access to `retentionMonths`:

```ts
// src/lib/logs/types.ts — BaseSink
write(entry: RequestLogEntry, settings: LoggingSettings): Promise<void>
```

`logRequest` (`src/lib/logs/index.ts:14`) switches from `getRequestLogStore()` to
`resolveRequestLogStore()`, which yields `settings` from the **same cached
resolution** — no extra query. `chat-handler.ts:303` already reaches for
`.settings.payloadMaxBytes` this way, so this follows an established pattern.

`postgresStore.write` ignores the second argument. The `writeOnlySink` test double
in `tests/helpers/logs.ts:42` is `async write() {}` and needs no change.

### Fitting under 400 KB

`chat-handler.ts:104-105` caps each side at `payloadMaxBytes` independently, so the
store can receive ~512 KiB at the 256 KiB default — over DynamoDB's 400 KB hard item
limit. The driver applies a second, combined cap:

1. Re-run `capPayload` on each side with `DYNAMO_PAYLOAD_MAX_BYTES = 150 KiB`. Reusing
   `capPayload` means oversized bodies get the **same truncation envelope** the
   detail page already renders (`src/app/(admin)/logs/[id]/page.tsx:31`), not a new
   shape the UI would have to learn.
2. Assemble the item and measure it. If it still exceeds 380 KB — pathological
   metadata, such as an enormous `attempts` array — replace both payloads with
   `{ truncated: true, error: 'too_large_for_store' }`.

Step 2 is what makes the write **fit by construction**. Without it a
`ValidationException` loses the entire log line, and because `logRequest` is
deliberately not awaited on the request path, that loss would surface only as a
stderr line.

### TTL stamping

`dropExpiredPartitions` drops month `M` when `M < addMonths(now, -(retentionMonths - 1))`.
Rearranged, `M` drops when `now >= addMonths(M, retentionMonths)`. So:

```ts
expiresAt = Math.floor(addMonths(monthStart(writeTime), settings.retentionMonths).getTime() / 1000)
```

Retention then behaves *identically* across both drivers rather than approximately.

`retentionMonths <= 0` omits `expiresAt` altogether — keep forever, mirroring
`if (retentionMonths <= 0) return []` in `partitions.ts:100`.

**Small refactor:** `monthStart` and `addMonths` move from
`src/lib/logs/partitions.ts` to a new `src/lib/logs/months.ts`, with their unit
tests. They are pure month arithmetic, and importing them from a module named
"partitions" into the DynamoDB driver would misdescribe both.

## Read path

### `query(filter)`

**Bounds.** Everything collapses into one sort-key range per shard:

```
lo = max( from ? uuidv7Bound(from) : MIN_UUID,  before ?? MIN_UUID )
hi = min( to   ? uuidv7Bound(to)   : MAX_UUID,  after  ?? MAX_UUID )

KeyConditionExpression: pk = :pk AND sk BETWEEN :lo AND :hi
```

where `MIN_UUID` is all zeros and `MAX_UUID` all `f`s.

DynamoDB permits exactly **one** sort-key condition, so `BETWEEN` — inclusive at
both ends — is the only option. Postgres uses `lt` for `to` and excludes the cursor
row. The difference is closed in the merge step by dropping any id equal to `after`,
`before`, or `uuidv7Bound(to)`. That is provably identical to the Postgres predicate
and costs one comparison, rather than string-predecessor arithmetic on uuids.

**Direction.** `before` set → `ScanIndexForward: true`, and the page is reversed
before returning. Otherwise descending. This mirrors `postgres.ts:104` exactly.

**Filters.** `apiKeyId`, `model`, and `outcome` as equality; `statusClass` as the
same three status ranges. All are `FilterExpression`, applied *after* `Limit` — which
is why the "fetch `limit + 1`, that tells you `hasMore`" trick at `postgres.ts:118`
cannot survive here.

### The merge

> **Frontier invariant.** A merged row may be emitted only if it sorts at or beyond
> the frontier of every non-exhausted shard.

A shard is **exhausted** when its `Query` returns no `LastEvaluatedKey`; its
**frontier** is the last id it returned. Rows past the highest frontier might be
outranked by rows a lagging shard has not yet returned. When fewer than `limit + 1`
rows are emittable and some shard is unexhausted, continue *those* shards with
`ExclusiveStartKey` and re-merge.

That invariant is what allows a small per-shard limit:

```
Limit = ceil((limit + 1) / SHARDS) + 4
```

Without it, correctness would require requesting `limit + 1` from all sixteen shards
and reading ~16× the data displayed. With it, under-supply is merely another round
trip.

**Budget.** The loop is capped at **8 round trips** and **10,000 items examined**
(summed `ScannedCount`). On exhaustion it returns a short page with `nextCursor`
set — paging still works, the page is just smaller than requested. This is a real,
user-visible difference from Postgres and is stated as such rather than hidden.

**Cursors** mirror `postgres.ts:127-135` verbatim:

```ts
nextCursor = rows.length && (before || hasMore) ? rows.at(-1).id : null
prevCursor = rows.length && (after || (before && hasMore)) ? rows[0].id : null
```

with `hasMore` = *emitted `limit + 1` matches, **or** the budget ran out while shards
were unexhausted*.

**`ProjectionExpression`** excludes `requestJson`/`responseJson` from list queries.
This is worth doing for latency and bandwidth, but note honestly what it does not do:
DynamoDB bills `Query` on the item size read *from storage*, before projection. It
does not reduce RCU.

### `get(id)`

1. `UUID_RE` guard → `null` with no round trip (same contract as `postgres.ts:22`).
2. `shard = id.slice(-1)`; one `GetItem` on `{ pk: "log#" + shard, sk: id }`.
3. Map attributes back, defaulting every absent one to `null`.
4. Payload rule copied from `postgres.ts:180`: **the stored attributes decide**
   whether a payload block renders, never the `payloadCaptured` flag. A row can carry
   the flag with nothing stored, and rendering a payload block for it would claim a
   body that does not exist.

## Retention and `maintain()`

`maintain()` returns `{ created: [], dropped: [] }` — the contract in `types.ts:63`
already anticipates a driver "with no storage of its own to provision".

It does one useful thing: a `DescribeTimeToLive` call, logging loudly to stderr if
TTL is not enabled on `expiresAt`. Because the operator provisions the table, a
forgotten TTL is both silent unbounded growth *and* a retention-policy violation on
captured prompt content. One API call per day is a cheap alarm for that.

`runLogMaintenance` already calls `maintain()` for **every** registered driver, not
just the active one, under a Postgres advisory lock. No change needed there.

## Configuration and registration

Environment only:

| Variable | Required | Purpose |
|---|---|---|
| `DYNAMODB_LOGS_TABLE` | yes | Table name — **and the enable switch** |
| `AWS_REGION` | yes | Standard AWS region |
| `DYNAMODB_ENDPOINT` | no | Override for DynamoDB Local in dev and tests |

Credentials come from the default AWS provider chain (env, SSO, instance/task role)
and never touch the settings table.

**The driver is registered in `DRIVERS` only when `DYNAMODB_LOGS_TABLE` is set.**
That single conditional buys four behaviours with no new machinery:

- The Settings picker maps `Object.values(DRIVERS)` (`settings/page.tsx:38`), so an
  unconfigured driver is simply not offered.
- A stale `logs.store = 'dynamodb'` on an unconfigured instance hits the **existing**
  `unknown_driver` fallback (`registry.ts:130`) → Postgres, with a clear stderr line.
- `runLogMaintenance` iterates `DRIVERS`, so an unregistered driver makes no AWS
  calls at all. It is inert by construction.
- There is no "configured but unusable" third state to design, test, or explain.

The Governance tab gains one line of copy explaining why DynamoDB may be absent from
the store list.

## Error handling

No new machinery. `loadLogs` (`admin/logs.ts:117`) and `loadLogDetail` already catch
and render the error banner rather than crashing the page.

The one addition: translate `ResourceNotFoundException` into a message naming the
missing table and pointing at `DYNAMODB_LOGS_TABLE`. Since the operator provisions
the table, this is the most likely misconfiguration, and the raw AWS error does not
say which table name the gateway was looking for.

Write failures reject rather than being swallowed, exactly as today — the caller's
`.catch()` reports them to stderr, and a logging failure never becomes a serving
failure.

## Testing

### Shared contract suite

The highest-value artifact here is not the DynamoDB tests but
`tests/lib/logs/store-contract.ts`: the store-contract assertions extracted into a
suite that **both** drivers run. That is what actually proves the drivers are
swappable, and it retro-fits coverage onto Postgres.

`postgres-store.test.ts` and a new `dynamodb-store.test.ts` both invoke it.

### Driver-specific tests

- **Shard derivation** — `get()` finds what `write()` put, across all sixteen hex
  digits.
- **The merge / frontier invariant** — against a **fake** DynamoDB client returning
  deliberately uneven and short shard pages. This is the one algorithm that can be
  subtly wrong and still pass an integration test by luck, so it is tested against a
  fake where page boundaries are controllable, not only against the real thing.
- **Fit by construction** — pathological payloads and an enormous `attempts` array
  still produce a sub-400 KB item.
- **TTL stamping** — including `retentionMonths: 0` omitting the attribute.
- **Null round-tripping** — an entry with every optional field absent survives
  `write` → `get` with nulls, not `undefined`.

### Infrastructure

`docker-compose.test.yml` gains `amazon/dynamodb-local` run with `-inMemory` on port
**8001**. In-memory and volume-less, consistent with the rule that test
infrastructure is disposable and that nothing automated touches port 5432.

`.env.test.example` gains `DYNAMODB_LOGS_TABLE`, `DYNAMODB_ENDPOINT`, `AWS_REGION`,
and dummy credentials — DynamoDB Local rejects requests with no credentials at all.

`tests/helpers/dynamo.ts` provides `createLogsTable()` / `resetLogsTable()`,
mirroring `resetDb()` in `tests/helpers/db.ts`.

**Known unknown:** `pnpm test:db:up` uses `--wait`, which requires a healthcheck, and
the `amazon/dynamodb-local` image ships no `curl` or `wget`. First attempt is a bash
TCP probe; the fallback is a short wait loop in the script. This is the one step in
the plan that may not work first try.

## Docs and IAM

README gains a DynamoDB store section with the environment variables, the table
definition for IaC (`pk`/`sk`, TTL on `expiresAt`, `PAY_PER_REQUEST`, no secondary
indexes), and the runtime IAM policy:

```
dynamodb:PutItem
dynamodb:GetItem
dynamodb:Query
dynamodb:DescribeTimeToLive
```

Notably **not** `CreateTable` or `UpdateTimeToLive`. The operator provisions the
table out of band, so the runtime role never needs permissions it would otherwise
carry purely for a first-boot path.

## Dependencies

- `@aws-sdk/client-dynamodb`
- `@aws-sdk/lib-dynamodb` (DocumentClient, configured with `removeUndefinedValues: true`)

## Behavioural differences from the Postgres store

These are accepted, not defects, and belong in the README:

1. **Filtered pages may be short.** When the scan budget is exhausted, a page returns
   fewer rows than the requested size. Paging continues to work correctly.
2. **TTL deletion is best-effort.** DynamoDB may take up to ~48 hours to remove an
   expired item. Expired-but-present rows remain queryable in that window.
3. **Retention changes are not retroactive.** `expiresAt` is stamped at write time,
   so lowering `retentionMonths` does not shorten the life of existing items.
   Postgres applies retention retroactively by dropping partitions.
4. **The payload cap is tighter.** 150 KiB per side on this driver, regardless of the
   configured `payloadMaxBytes`.
5. **The shard count is immutable** once data exists.

## Rejected alternatives

**Time-bucketed partition key** (`pk = "<YYYY-MM-DD>#<shard>"`). Identical write
throughput, but reads must *walk* buckets backwards, and a sparse or wide range burns
queries on empty days. Same fan-out cost plus a bucket loop, for no gain — TTL
already makes expiry contiguity irrelevant.

**GSI-backed filters or `pk = apiKeyId`.** Fast for filtered views, but the
*unfiltered* dashboard — the common case — then needs a global time index, and every
GSI replicates every write. That is precisely the write cost this design exists to
avoid.

**S3 payload offload.** Cheaper for the heavy tail and preserves full fidelity, but
adds an S3 dependency, IAM surface, and a lifecycle policy — DynamoDB TTL cannot
expire S3 objects, so retention would become two mechanisms that can disagree.
Typical payloads are a few KB; the tighter cap handles the tail at a fraction of the
complexity.

**Splitting payloads into a second item** (`sk = "<id>#payload"`) so list queries
never read payload bytes. Genuinely cheaper, but it reintroduces exactly what
`postgres.ts:70` records having removed: "the two-row transaction this replaced — and
the window where a log row could claim a payload that was never written — are both
gone." Not worth trading a correctness property for a cost the small per-shard
`Limit` already largely solves.

**Gateway auto-provisioning the table.** Zero-config for self-hosters and consistent
with the Postgres boot path, but it requires `CreateTable` and `UpdateTimeToLive` on
the runtime role permanently, to serve a path that runs once.
