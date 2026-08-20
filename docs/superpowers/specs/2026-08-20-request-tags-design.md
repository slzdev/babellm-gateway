# Request tags (`x-babellm-tags`) — design

A client can label a request with arbitrary `key=value` pairs by sending an
`x-babellm-tags` header. The gateway validates them, stores them on the request
log, and lets an operator filter `/logs` by them. Nothing else reads them.

## 1. Problem

`/logs` can answer "which requests did this key make", "against this model",
"with this status". It cannot answer any question the *caller* knows the shape
of and the gateway does not: which requests came from the checkout flow, which
belong to a given end customer, which came from the staging deployment that
shares a key with production.

The gateway has no way to learn these facts. They are not derivable from the
body, the key, or the route — they exist only in the caller's own context. A
per-key split is the closest approximation available today, and it is a bad one:
it forces an operator to mint and rotate a key per dimension they want to slice
by, and it collapses the moment two dimensions cross (an `env` *and* a `team`
needs a key per pair).

The missing piece is a channel for the caller to attach its own context to a
request, and a way to search on it afterwards.

## 2. Scope

**In:**

- An `x-babellm-tags` request header carrying comma-separated `key=value` pairs,
  accepted on every endpoint that runs through `runGatewayRequest` — today
  `POST /v1/chat/completions` and `POST /v1/responses`.
- Strict validation, with a `400` for anything that does not parse.
- A nullable `tags jsonb` column on `request_logs`.
- Filtering `/logs` by any number of pairs, ANDed.
- Tags rendered on the log detail page.

**Out, by decision:**

- **No usage or cost breakdown by tag.** That needs a tag dimension in
  `usage_rollups`, whose grain is a fixed six-column unique constraint. Adding a
  free-form dimension to a pre-aggregation is a different feature with a
  different cost, and it multiplies row count by tag cardinality — the one thing
  the rollup table exists to avoid.
- **No limits or budgets scoped to a tag.** Enforcement requires tags to be
  pre-registered and owned by an operator; these are free-form and owned by the
  caller.
- **Tags are not forwarded upstream.** No provider `metadata` field is
  populated. That is a translation concern, per-adapter, and would make the
  header's meaning depend on which target happened to serve.
- **No source of tags other than the header.** No `default_tags` on `api_keys`,
  no body field. One source means one contract and no merge-precedence rule;
  a caller that wants every request tagged sets the header in its client
  wrapper.
- **No index on the column.** See §3.4.
- **No autocomplete of known tag keys or values.** That needs a facet query over
  `request_logs`, or a registry table fed by the write path. Both are real cost
  in service of discovery on a page whose users wrote the tags themselves.
- **No tags column in the logs table.** Detail page only; see §3.8.

## 3. Decisions

### 3.1 Why `key=value` rather than flat labels

A flat label set (`prod,checkout`) is simpler to store and to validate, but it
has no notion of a dimension, so it cannot express "the `env` of this request"
— only "this request carries the string `prod`". Every question an operator
actually asks is about a dimension, and the flat form makes two of them
indistinguishable the first time a value collides across dimensions (a team
named `checkout` and a feature named `checkout`).

Pairs also give the filter an obvious semantics — `env` **is** `prod` — and map
one-to-one onto a `jsonb` object, so the storage shape is the wire shape is the
filter shape.

The key charset excludes `=`, which is what lets a token be split on its
**first** `=` with no ambiguity and no escaping rule: `note=a=b` is the key
`note` with the value `a=b`.

### 3.2 Why a malformed header is a `400` rather than ignored

The alternative — drop the header, serve the request — protects the valuable
part of the call, and is what a gateway should usually do with metadata it
cannot understand. It is wrong here for one reason: silence makes a tracking
feature untrustworthy in exactly the case where it matters.

A caller who typos a tag and is not told gets a dashboard that is quietly
missing a slice of its traffic. They cannot detect it from the client (the call
succeeded) or from `/logs` (the rows are there, just untagged), and the number
they eventually read is wrong by an amount nobody can measure. A `400` on the
first request in development costs a minute; a silently short count costs the
trust in every count on the page.

This is the same stance §3.5 of the Responses ingress design took for hosted
tools: refuse rather than answer a request whose meaning the gateway cannot
honour.

### 3.3 Why validation runs after `resolveApiKey` and before `ingress.parse`

**After the key** so the rejection is attributable. A `GatewayError` thrown
anywhere inside `runGatewayRequest`'s `try` is already logged by the existing
`catch`, which reads `keyId` and `keyName` from the enclosing scope — so
placing the check after `resolveApiKey` means a tag rejection appears on `/logs`
as a `client_error` against the key that sent it, with no new logging plumbing
at all. Before the key, it would be an anonymous 400 with no trace.

**Before the body parse** for two reasons. It is the cheaper check, and running
it first means a request with both a malformed body and a malformed header is
told about the header — the outer envelope, which is what the caller controls
from their wrapper rather than from the call site. More usefully, it means a
successfully parsed tag set is in scope *before* anything else can fail, so a
request that dies in body parsing, model resolution, or upstream still carries
its tags on the log row. Tags are most valuable on the requests that went wrong,
so they must not be conditional on the request going right.

The one consequence to accept: a request rejected for bad tags never reaches
`checkLimits`, so it does not consume rpm. This matches the existing ordering
comment, which puts limits after parsing "so a malformed body cannot consume
rpm".

### 3.4 Why `jsonb` with no index

Filtering is a single containment operator, `tags @> '{"env":"prod"}'::jsonb`,
which ANDs every pair at once regardless of how many are supplied. Containment
is exactly what a GIN index accelerates, and exactly the thing this design does
not build yet.

At the stated volume — on the order of 100k requests a day — the index earns
nothing. Every `/logs` query is already bounded by the uuid-v7 keyset range,
which prunes to the partitions inside the selected time window; a containment
filter therefore scans a bounded slice, not the table. A GIN index would add
write amplification to the hot insert path and storage to every partition, in
exchange for speeding up a scan that is already short.

The decision is cheap to revisit, which is the point: `CREATE INDEX … USING GIN
(tags jsonb_path_ops)` drops into `ensurePartitions()` alongside the
`CREATE TABLE … PARTITION OF`, with no change to the column, the queries, or
any code that reads them.

### 3.5 Why not a separate `request_log_tags` table

A normalized side table is the textbook shape for a many-to-one set, and it is
ruled out by the same constraint that keeps payloads inline. `request_logs` is
partitioned, and retention works by dropping whole partitions; an inbound
foreign key makes a partition undroppable. A tags table keyed to
`request_logs.id` is precisely that inbound key, so retention would have to
become a delete-by-range against a second table — the exact cost partitioning
was chosen to avoid. Without the foreign key it is an unenforced join key on a
table that can vanish underneath it, which is worse than a column.

### 3.6 Why `NULL` and never `{}`

A row with no tags column value means "this request sent no tags header". If the
write path stored `{}` for a request without the header, that state would become
indistinguishable from the pre-migration past, where every row is `NULL` because
the feature did not exist.

Keeping `NULL` as the only "no tags" representation also makes the filter behave
correctly with no special case: `tags @> '{"env":"prod"}'` evaluates to `NULL`
for a `NULL` column, so untagged and historical rows are excluded from every tag
filter rather than matching an empty object. Nothing needs backfilling — those
requests genuinely carried no tags.

### 3.7 Why the ingress and the filter share one validator

The gateway lowercases keys on the way in. If `/logs` did not apply the same
normalization to a filter typed into the dashboard, a search for `Env=prod`
would return nothing while the rows sat there stored as `env`. A shared
`parseTags` is what makes "what you can send" and "what you can search for" the
same language by construction rather than by two implementations agreeing.

They differ in one respect, and only one: **the ingress throws, the filter
drops.** `parseLogFilter` already establishes that "every unrecognized value
degrades to the default rather than throwing: a hand-edited URL should show the
default view, not an error page", and a tag param follows that contract like
every other. So the shared function returns a result the two callers interpret
differently, rather than one that throws for both.

### 3.8 Why the detail page and not the logs table

The logs table already carries time, key, model, stream, status, provider,
upstream model, latency, TTFT, prompt and completion tokens, and cost. A tags
column would either be too narrow to read (one chip and a `+3`) or would push
something else off the row. The filter is the way tags are used at the list
level — you narrow to the tag you care about, and the rows are the answer — and
the detail page is where the full set is worth reading.

## 4. The header contract

```
x-babellm-tags: env=prod,feature=checkout,customer=acme-3122
```

Parsed by splitting on `,`, then splitting each token on its first `=`. Both
sides are trimmed. Keys are lowercased; values keep their case, because a value
is data (`customer=Acme` and `customer=acme` may be different customers) while a
key is a dimension name.

| Rule | Limit |
| --- | --- |
| Header size | raw value ≤ 2048 UTF-8 bytes, measured before parsing |
| Pairs | ≤ 16 |
| Key | matches `^[a-z0-9_.-]{1,64}$` after lowercasing |
| Value | 1–256 characters after trimming, no control characters, no `,` |
| Duplicate key | rejected, after lowercasing |

The limits are checked in that order, so an abusive header is rejected on size
before anything iterates over it.

An absent header, or a header whose value is empty or all whitespace, means no
tags: `null`, not an error and not `{}`.

A repeated header line needs no special handling. `Headers.get()` joins repeats
with `, `, which is already the pair separator — so two `x-babellm-tags` lines
behave exactly as if their contents had been written as one comma-separated
list, including rejecting a key the two of them both set.

Anything else is a `400` carrying a `GatewayError` with type
`invalid_request_error`, code `invalid_tags`, and a message naming the specific
failure and the offending token — `x-babellm-tags: duplicate key "env"`,
`x-babellm-tags: key "Team Name" is not a valid tag key`, `x-babellm-tags: at
most 16 tags, got 21`. A message that only says "invalid" forces the caller to
bisect their own header.

Values may not contain `,` because the separator is unescaped. This is a real
limit and it is stated rather than worked around: an escaping scheme would make
the header harder to write by hand for the sake of a case (a comma inside a tag
value) that a caller can trivially avoid.

## 5. Implementation

### 5.1 Two modules, for the same reason `log-filter-params.ts` exists

The pure parser and the throwing wrapper live in **separate files**, and the
boundary is a bundling constraint rather than a stylistic one. The filter bar is
a Client Component, so everything it imports enters the browser bundle;
`src/lib/gateway/errors.ts`, where `GatewayError` lives, imports the `openai`
package. A single module exporting both `parseTags` and a wrapper that throws
`GatewayError` would pull the OpenAI SDK into the browser the moment the filter
bar imported it. This is the hazard `src/lib/admin/log-filter-params.ts` already
documents for the `server-only` chain, and the split is the same answer.

**`src/lib/tags.ts`** — pure, no imports, no `server-only`, safe in a client
bundle:

```ts
export const TAGS_HEADER = 'x-babellm-tags'

export type TagParse =
  | { ok: true; tags: Record<string, string> | null }
  | { ok: false; message: string }

/** Parses a raw header value. Returns a failure rather than throwing, so the
 *  admin filter can drop what the ingress rejects. */
export function parseTags(raw: string | null): TagParse
```

**`src/lib/gateway/tags.ts`** — the ingress wrapper, which may import freely:

```ts
/** Reads and validates the header. Throws a GatewayError on failure. */
export function tagsFromRequest(request: Request): Record<string, string> | null
```

Splitting the pure parser from the throwing wrapper is also what lets §3.7's two
callers share one set of rules while interpreting failure differently.

### 5.2 `src/lib/gateway/handler.ts`

A `let tags: Record<string, string> | null = null` beside the other
tracked-outside-the-`try` bindings, assigned from `tagsFromRequest(request)` as
the first statement after `resolveApiKey`, and passed through `writeLog` into
`logRequest`. No change to the `Ingress` interface — the header is read from the
`Request`, which the shared lifecycle already holds, so both ingresses get it
without knowing it exists.

### 5.3 Schema and migration

```ts
tags: jsonb('tags').$type<Record<string, string> | null>(),
```

on `requestLogs`, generating `ALTER TABLE "request_logs" ADD COLUMN "tags"
jsonb;`. Because the table is declaratively partitioned, Postgres adds the
column to every attached partition in the same transaction — a partition cannot
diverge from its parent's column list — and future partitions from
`ensurePartitions()` inherit it at creation. The column is nullable with no
default, so this is a catalog-only change with no rewrite; it takes a brief
`ACCESS EXCLUSIVE` lock on the parent and all partitions, which at this size is
milliseconds. Unlike `0003`, this migration needs no hand editing.

`RequestLogEntry`, `LogRow`, and `LogDetail` in `src/lib/logs/types.ts` each gain
`tags: Record<string, string> | null`. `LogRow` carries it even though the table
does not render it, so that click-to-filter remains a UI change later rather
than a query change.

### 5.4 Query

`LogFilter` gains `tags?: Record<string, string>`, and `conditions()` in
`src/lib/logs/postgres.ts` gains one clause:

```ts
if (filter.tags) {
  where.push(sql`${requestLogs.tags} @> ${JSON.stringify(filter.tags)}::jsonb`)
}
```

Parameterized, so a tag value is never interpolated into SQL.

### 5.5 URL parameters

Repeated `tag` params, each a `key=value` token:

```
/logs?range=24h&tag=env=prod&tag=team=a
```

`LogSearchParams.tag` is typed `string | string[]`, since Next supplies an array
for a repeated param and a bare string for a single one. `parseLogFilter`
normalizes to an array, runs each token through `parseTags`, drops every token
that fails or duplicates a key already seen, and omits `tags` entirely if
nothing survives — the established degrade-don't-throw contract.

### 5.6 UI

`log-filter-params.ts` gains `addTagParam` and `removeTagParam`. The existing
`nextFilterParams` cannot be reused: it calls `URLSearchParams.set`, which
replaces every value of a name, and `tag` is the first multi-valued filter. The
new helpers use `append` and a filtered rebuild respectively, and both clear the
`after`/`before` cursors exactly as `nextFilterParams` does — a filter change
makes the old keyset position meaningless whether the filter is single- or
multi-valued. `NEUTRAL_VALUES` is untouched: `tag` has no neutral value, since
its absence is expressed by having no `tag` params at all.

`log-filters.tsx` gains a key input, a value input, and an add button, which
appends a `tag` param. Active tags render as removable shadcn `Badge` chips that
rewrite the query string, matching how the other filters already drive the URL.
The bar validates the typed pair with `parseTags` before appending, so an
invalid tag is refused at the input rather than silently dropped server-side,
and the chip shows the normalized (lowercased-key) form that will actually
match.
`logs/[id]/page.tsx` renders the row's tags as `Badge` chips, or nothing at all
when `tags` is `null`. `badge`, `input`, and `button` are all installed; no new
shadcn component is required.

## 6. Testing

**Parser** (`tests/lib/tags.test.ts`) — the accepted form; absent,
empty, and whitespace-only headers all yielding `null`; key lowercasing; value
case preserved; `note=a=b` splitting on the first `=`; and one case per
rejection: bad key charset, key over 64, empty value, value over 256, 17 pairs,
a header over 2048 bytes, and a duplicate key. Each rejection asserts the
message names the offending token, since §4 makes that part of the contract.

**Handler** (`tests/gateway/tags.test.ts`, beside the existing
`request-logging.test.ts`) — a bad header returns `400`
with code `invalid_tags` *and* writes a log row bearing the key that sent it; a
good header's tags reach the log row on a successful request; and, the case that
justifies the ordering in §3.3, tags reach the log row when the request fails
upstream and when the body fails to parse.

**Store** (`tests/lib/logs/postgres-store.test.ts`) — containment ANDs correctly
across two pairs; a filter matching a subset of a row's tags still matches; a
row whose `tags` is `NULL` matches no tag filter.

**Filter parsing** (`tests/lib/admin/logs.test.ts`) — a single `tag`, repeated
`tag`s, a malformed `tag` dropped rather than thrown, an all-malformed list
omitting `tags` from the filter, and `Env=prod` normalizing to `env` so the
dashboard finds what the gateway stored.

All against the disposable Postgres on 5434, using this worktree's own
`babellm_test_tags` database.

## 7. Known limitations

- **Tag values cannot contain a comma.** §4.
- **A tag is only as good as the caller's discipline.** Nothing prevents `env`
  and `environment` becoming two dimensions meaning one thing. A registry of
  known keys would fix it and is deliberately not built.
- **Tags die with their partition.** They live only on `request_logs`, so they
  disappear at the retention horizon along with the rest of the row. There is no
  tag history in `usage_rollups`, which is the direct consequence of leaving
  usage breakdown out of scope.
- **Filtering is conjunctive only.** No OR, no negation, no wildcard, no
  "has key with any value".
- **A tag filter over a long range scans.** With no index and a `range=all`
  selection, containment reads every partition in the retention window. The
  mitigation is the index in §3.4, once volume justifies it.
