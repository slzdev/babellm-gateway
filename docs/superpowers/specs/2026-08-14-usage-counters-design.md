# Per-key usage counters and limit enforcement

Status: design
Date: 2026-08-14

## 1. What this is

`api_keys` has carried `rpm_limit`, `tpm_limit`, `budget_monthly_usd`,
`budget_total_usd`, and `spend_total_usd` since Phase 1. Nothing reads them.
The README says so outright: "A configured budget is not a spend cap."

This adds the counter store those columns need, and turns them into
enforcement. A key over its limit gets a `429`. The counters live in a store
behind a two-method interface with two drivers: an in-process `Map` by
default, and Redis when `REDIS_URL` is set.

The store is deliberately generic — it counts things and returns numbers. It
knows nothing about rate limiting, windows, or money. Everything that encodes
product behaviour lives in one shared module above it, which is what keeps the
two drivers honest.

## 2. Non-goals

- **Per-user, per-provider, and per-model counters.** The interface accepts
  arbitrary counter names, so these are additive later. v1 counts per key.
- **Concurrency limits.** In-flight counts need TTL'd leases to survive a crash
  without leaking; that is a different mechanism and does not belong in the
  same change.
- **Durable spend.** See §4. Spend lives in the store and only in the store.
- **Reservation-and-settle.** The check is before the request, the charge is
  after it. §8 states the overshoot this permits.
- **Redis Cluster or Sentinel.** A single `REDIS_URL`. `ioredis` supports both
  and the driver would extend to them, but nothing here is written or tested
  for them.

## 3. Decisions

| Question | Decision |
|---|---|
| Purpose | Enforce. Over limit → `429`. |
| Spend truth | The store owns it. No Postgres spend column. |
| Cold start | Counters start at zero. Documented, not mitigated. |
| Store failure | Fail open — log, skip the check, serve. |
| Window | Sliding window counter (two weighted buckets). |
| Counters | Per key: rpm, tpm, monthly spend, total spend. |
| Config | `REDIS_URL` env var. Set → Redis, unset → memory. No DB setting. |
| tpm and budget timing | Check before, charge after. |
| Month boundary | Calendar month, UTC. |
| Visibility | Keys page columns, `x-ratelimit-*` headers, Governance status. |
| Rejections | Not written to `request_logs`. Do not consume rpm. |
| Atomicity | `INCRBY`/`INCRBYFLOAT` return values. No Lua. |

## 4. Spend is volatile, on purpose

The store owns accumulated spend outright. There is no Postgres column behind
it and no rehydration path. A restart in memory mode, or a Redis instance
without `AOF`/`RDB` persistence being flushed, sets every key's spend back to
zero.

This is a deliberate trade for a hot path with no writes to Postgres and no
reconciliation logic, and it has a consequence worth stating in the plainest
terms available, because it will otherwise be discovered the expensive way:

> **A budget is only as durable as the store holding it.** In memory mode,
> `budget_total_usd` means "spend since this process started". Budgets are
> meaningful across restarts only against a Redis configured to persist.

The README and the Governance tab both say this. `api_keys.spend_total_usd` is
dropped in this change rather than left as a column nothing writes — a
plausible-looking zero is worse than an absent field.

Historical spend is not lost by any of this: `request_logs.cost_usd` still
records what every request cost, subject to log retention. What resets is the
running counter the budget check reads.

## 5. The store interface

```ts
// src/lib/usage/types.ts

/** One counter mutation. `by: 0` is a read. */
export interface CounterOp {
  key: string
  /** Integer counters use INCRBY; money uses INCRBYFLOAT. */
  kind: 'int' | 'float'
  by: number
  /** Seconds. Applied on every write; omitted means "never expires". */
  ttlSeconds?: number
}

export interface UsageStore {
  readonly name: string
  /**
   * Applies every op in one round trip and returns each counter's value
   * *after* this op's contribution, in the order given.
   *
   * The return value is what makes this safe without server-side scripting:
   * two concurrent callers incrementing the same counter get different
   * numbers back, so each can decide for itself whether it was the one that
   * crossed the line.
   */
  apply(ops: CounterOp[]): Promise<number[]>
  /** Delete counters outright. The caller names them; the driver does not
   *  know what a key id is. Used when an API key is deleted. */
  del(keys: string[]): Promise<void>
  /** For the Governance tab. Reports last known state; never connects. */
  status(): { healthy: boolean; error: string | null }
  close?(): Promise<void>
}
```

No `check`, no `record`, no notion of a limit — and no notion of an API key
either: `del` takes the counter names the caller computed. A driver that
implements `apply` correctly cannot get rate limiting wrong, because it does
not do rate limiting.

### Why this is atomic enough without Lua

The only operation that needs to be atomic is "add to a counter and tell me the
result", and `INCRBY` and `INCRBYFLOAT` are exactly that. Server-side scripting
would only be needed to *branch* on a value inside Redis — to check and
increment conditionally in one shot. The "check before, charge after" model
(§8) never needs that: every decision is made from values Redis has already
returned.

Grouping is `MULTI`/`EXEC`, which gives one round trip and keeps a counter's
`INCRBY` and its `EXPIRE` from being separated by a crash. Redis executes the
whole transaction without interleaving another client's commands, which is all
this needs; it never has to branch mid-transaction.

## 6. Counter keys

```
babellm:usage:rpm:<keyId>:<minuteEpoch>        int    ttl 120s
babellm:usage:tpm:<keyId>:<minuteEpoch>        int    ttl 120s
babellm:usage:spend:<keyId>:<YYYY-MM>          float  ttl 70d
babellm:usage:spend:<keyId>:total              float  no ttl
```

`minuteEpoch` is `Math.floor(now / 60_000)`. The bucket a request lands in is
decided by its name, so a window never has to be reset — it expires.

`YYYY-MM` is UTC. The month boundary is therefore free: on the 1st at 00:00
UTC, requests start naming a key that does not exist yet, which reads as zero.
The 70-day TTL is refreshed on write, so a month's counter survives about ten
weeks past its last use — long enough to still be readable during the month
after, short enough not to accumulate.

The fixed `babellm:usage:` prefix keeps a shared Redis legible and makes
`clear` a bounded set of `DEL`s rather than a `SCAN`.

## 7. Drivers

### memory

A `Map<string, { value: number; expiresAt: number | null }>`. `apply` walks the
ops, dropping any entry whose `expiresAt` has passed before reading it (lazy
expiry — a sweep would be pure overhead for a map this small). Single process,
so every op is trivially atomic.

A periodic sweep of expired entries runs on a 60s interval so an instance
serving many keys does not hold dead minute buckets indefinitely. This is
memory hygiene, not correctness.

**Per-instance by construction.** Two gateway replicas in memory mode each
enforce the full limit, so the effective limit is `replicas × rpm_limit`. This
is stated in the README and on the Governance tab.

### redis

`ioredis`, configured for a fail-open caller:

```ts
new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false,  // fail fast when down, never queue
  maxRetriesPerRequest: 1,
  commandTimeout: 250,
  connectTimeout: 1000,
})
```

`enableOfflineQueue: false` is the important one: with the queue on, a command
issued while Redis is unreachable waits for reconnection instead of rejecting,
which would turn a Redis outage into gateway latency — the exact thing the
fail-open decision exists to prevent.

No `lazyConnect`: the client dials as soon as it is constructed. That would
normally race the very first command against the TCP handshake — with
`enableOfflineQueue: false`, a command issued before the first `ready` rejects
immediately instead of waiting, so a caller that builds the store and uses it
in the same tick (a contract test, or the first request after boot if it
arrives fast enough) would fail every time, not just on rare bad luck.
`apply`/`del` instead await a one-time, bounded first-connect wait — resolved
by the first `ready` or by `connectTimeout`, whichever comes first — before
issuing their command. It never rejects: a boot with Redis down must resolve,
not throw, so the normal fail-open path still handles it. This wait is
one-shot; a live outage after the first connect skips it entirely and fails
fast with no added latency, exactly as before.

`apply` builds one `multi()`:

- `by > 0`, `int` → `incrby(key, by)`, then `expire(key, ttl)` if set
- `by > 0`, `float` → `incrbyfloat(key, by)`, then `expire`
- `by === 0` → `get(key)`, mapped to `0` for a missing key

`incrbyfloat` and `get` return strings; the driver parses them. A missing
counter reads as `0` — there is no distinction here between "nothing yet" and
"zero", unlike in the log pricing code, because a counter genuinely starts at
zero.

`del` is a plain `DEL` of the names it is given. `limits.ts` exports
`clearUsage(keyId)`, which computes that list — the total and current-month
spend keys, and the current and previous minute buckets for rpm and tpm — and
calls it. Older buckets are already expiring; nothing needs scanning.

### Resolution

```ts
// src/lib/usage/registry.ts
export function getUsageStore(): UsageStore   // memoized singleton
export function resetUsageStore(): void       // tests
export function usageStoreStatus(): { driver: string; healthy: boolean; error: string | null }
```

`REDIS_URL` set → redis driver; unset → memory. Read once at first use. No
settings row, no dropdown, no way to change infrastructure from the dashboard
— consistent with how `DATABASE_URL` and `ENCRYPTION_KEY` are already handled,
and it keeps a Redis credential out of the database.

`usageStoreStatus()` reports the last observed connection state for the
Governance tab. It never blocks on or awaits a connection of its own — but
`getUsageStore()`, which it calls to resolve the singleton, does construct
the redis client on first use, and that client dials immediately (§7). So the
first render after boot can observe the client still short of its first
`ready`. `status()` treats that as its own neutral state — `{ healthy: false,
error: null }` — rather than as a failure: `error` is reserved for an actual
`error` event, so "still connecting" and "unreachable" read differently on
the Governance tab instead of both showing as the destructive case.

## 8. The limits module

`src/lib/usage/limits.ts` holds every decision. It is the only module that
knows what a limit is.

### Sliding window

```
bucket   = floor(now / 60_000)
elapsed  = (now % 60_000) / 60_000          // 0 … 1 through the current minute
estimate = previous * (1 - elapsed) + current
```

At 15 seconds past the minute, a previous bucket of 100 contributes 75. The
boundary burst a fixed window permits (2× the limit in one second) shrinks to a
few percent, and it costs one extra `GET` in a batch that was already being
sent.

### The check

Skipped entirely when a key has no `rpm_limit`, no `tpm_limit`, and neither
budget: no counters, no round trip, no cost. **A key with no limits configured
therefore has no live usage to display** — its Keys-page usage cell reads `—`.
Its history is still in `request_logs`; what it does not have is a running
counter. This is the price of unlimited keys costing nothing.

For a key with at least one limit, one `apply` call carries everything:

| op | why |
|---|---|
| `incrby rpm:<id>:<bucket>` by 1 | this request is the one being decided |
| `get rpm:<id>:<bucket-1>` | the weighted tail |
| `get tpm:<id>:<bucket>` | read only — tokens are unknown until after |
| `get tpm:<id>:<bucket-1>` | |
| `get spend:<id>:<month>` | |
| `get spend:<id>:total` | |

Ops for limits the key has not configured are omitted.

The comparison differs between rpm and everything else, and the difference is
not arbitrary. The rpm counter has **already been incremented for this
request**, so the question is "does this request fit": reject when
`estimate > rpmLimit`. The tpm and spend counters do **not** include this
request and cannot, so the question is "is there any room left at all":
reject when `estimate >= tpmLimit`, `month >= budgetMonthlyUsd`, or
`total >= budgetTotalUsd`.

The first breach found wins, checked in this order: rpm, tpm, monthly budget,
total budget. A key that is both throttled and out of budget is told it is
throttled, because that is the condition that will clear on its own.

### Rejections do not consume rpm

A rejected request compensates with a `decrby` on the bucket it incremented,
carrying the same `ttlSeconds` as the `incrby` it undoes — one extra round
trip on a path that is already failing. A client hammering a throttled key
therefore cannot extend its own lockout.

The `ttlSeconds` on the `decrby` is deliberate, not redundant. A bucket's
identity is its key *name* — the minute number baked into the key — not its
TTL, so refreshing the expiry cannot extend the window; it only extends how
long a dead bucket stays around. Omitting it would be a leak: if the window
has already expired by the time the compensating `decrby` runs, a bare
`INCRBY` recreates the key from nothing with no TTL at all, leaving a
permanent `-1` counter behind.

The honest cost: **if the process dies between the `incrby` and the `decrby`,
that key's window reads one too high for up to two minutes.** That is the
entire price of not using server-side scripting, and it is bounded by a TTL.

### The charge

After the response, with real numbers in hand:

```
incrby      tpm:<id>:<bucket>       promptTokens + completionTokens
incrbyfloat spend:<id>:<month>      cost.totalUsd
incrbyfloat spend:<id>:total        cost.totalUsd
```

One batch, fire-and-forget, never awaited on the response path — the same rule
the log write already follows. No usage reported by the provider means no
charge: a null count is not a zero (`usageFrom` already draws that line).
Unpriced models charge tokens but no money, because `computeCost` returns null
rather than zero for them.

Spend accumulates in floating point rather than Postgres `numeric`. Costs are
around 1e-9 and budgets around 1e1, so a double holds far more precision than
the comparison needs; `pricing.ts` already documents and accepts float
arithmetic at this scale for the same reason.

### Accepted overshoot

The check is before the request and the charge is after it, so a key can cross
its limit by the requests already in flight when it crossed. With `n`
concurrent requests, the overshoot is bounded by `n` requests' worth of tokens
and cost. This is the trade named in the original gateway design and it is
taken again here: reservation-and-settle needs a tokenizer this repo does not
have, and a wrong estimate rejects requests that would have fit.

### Fail open

Every store call in this module is wrapped: any throw or timeout is logged and
treated as "no opinion". The request proceeds, and no `x-ratelimit-*` headers
are emitted — absent headers are honest about a check that did not happen,
where headers computed from nothing would not be.

The failure log is throttled to one line per 10 seconds per driver. A Redis
outage under load must not turn into a stderr flood that costs more than the
outage.

## 9. Request lifecycle

```
auth → parse body → LIMIT CHECK → resolve model → select → attempt loop → CHARGE + log
```

The check sits after body parsing and before `resolveModel`. Before parsing, a
malformed body would consume rpm for a request that never had one. After model
resolution, a throttled key would pay for a database lookup — and a throttled
key asking for a nonexistent model would get `429` where `404` is the more
useful answer.

The charge happens where the log is already written — the same place in both
the streaming and non-streaming paths, sharing the `CostBreakdown` that
`writeLog` already computes so pricing is resolved once per request rather than
twice.

### The rejection response

```
HTTP/1.1 429
Retry-After: 42
x-request-id: <uuid>
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 0
x-ratelimit-reset-requests: 42

{"error":{"message":"…","type":"rate_limit_error","code":"rate_limit_exceeded","param":null}}
```

A `GatewayError` like any other, so the existing `errorResponse` envelope
carries it unchanged.

| Breach | code | `Retry-After` |
|---|---|---|
| rpm | `rate_limit_exceeded` | seconds to the end of the current minute |
| tpm | `rate_limit_exceeded` | seconds to the end of the current minute |
| monthly budget | `insufficient_quota` | seconds to 00:00 UTC on the 1st |
| total budget | `insufficient_quota` | omitted — it never recovers |

The rate-limit `Retry-After` is the honest floor rather than a precise answer:
a sliding window relieves gradually, so the end of the bucket is when the
weight of the offending minute has certainly rolled off.

### Rejections are not logged

Per the design decision, a limit rejection is **not** written to
`request_logs`. This is an explicit exception to the handler's current
behaviour, where the `catch` logs every error including `401`s.

The mechanism: the check throws a `LimitExceededError extends GatewayError`,
and the handler's `catch` returns it through `errorResponse` without calling
`log()`. A dedicated class rather than sniffing for status `429` — an upstream
provider's `429` reaching the catch is a completely different event and must
still be logged.

The consequence, stated so it is a choice and not a surprise: **throttling is
invisible on the Logs page.** The evidence a key is being limited is its Keys
page usage cell sitting at its limit, and the client's own `429`s. If that
proves too thin, the cheapest fix later is a counter of rejections per key in
this same store — not a log row per rejection, which is the traffic pattern
that would grow fastest exactly when the gateway is under the most stress.

## 10. Response headers on served requests

The check already computed everything needed, so successful responses carry it:

```
x-ratelimit-limit-requests / -remaining-requests / -reset-requests
x-ratelimit-limit-tokens   / -remaining-tokens   / -reset-tokens
```

Emitted only for limits the key actually has. `remaining` is
`max(0, limit - estimate)` rounded down; `reset` is integer seconds to the end
of the current bucket. OpenAI writes durations as `6m0s`; integer seconds is
easier to parse and is what this gateway sends.

`attemptHeaders` takes the check's decision as a new optional argument and
merges them in, so streaming and non-streaming responses get them from one
place. A skipped or failed check passes nothing and the headers are absent.

Budget has no header. There is no OpenAI convention for one, and inventing
`x-babellm-budget-remaining` would leak spend to every caller holding the key.

## 11. Schema

One migration: drop `api_keys.spend_total_usd`. Nothing reads it, nothing
writes it, and §4 explains why nothing will.

The four limit columns are untouched. They are read on every request already —
`resolveApiKey` returns the whole row — so a limit change takes effect on the
next request with no cache to invalidate.

`deleteApiKey` gains a `clearUsage(id)` call so a deleted key does not leave its
total-spend counter (the one with no TTL) behind forever. Fire-and-forget: a
store that is down must not fail a delete.

## 12. Admin UI

**Keys page** — a Usage column beside Limits:

```
Limits              Usage
60 rpm · $50/mo     12 rpm · $3.20
none                —
```

One `apply` batch reads every listed key's counters, so the page costs one
round trip regardless of key count. Keys with no limits show `—` (§8). A store
failure shows `—` too, with the Governance tab as the place that explains why.

**Governance tab** — a read-only Usage counters section beneath the log store
form:

- Driver: `memory` or `redis`, and for redis whether it is currently reachable
- The reset warning from §4, worded for whichever driver is active — memory
  says counters reset on restart; redis says they reset if Redis is flushed or
  running without persistence
- For memory with no `REDIS_URL`: the note that limits are enforced per
  instance

No form. The driver is an environment variable and the tab says so.

**The Keys page header** currently reads "Rate limits and budgets are recorded
but not enforced until Phase 4." It becomes a statement of what is enforced and
of the durability caveat.

## 13. Testing

**Store contract, run twice.** One suite describing `apply`/`clear` behaviour —
increment returns the post-value, concurrent increments never return the same
number, `by: 0` reads without creating junk, TTLs expire, floats accumulate,
`clear` removes everything — executed against both drivers from one file. This
is what makes the generic interface worth having: the drivers are proven
equivalent rather than separately plausible.

**Disposable Redis.** `docker-compose.test.yml` gains a tmpfs Redis on **6380**
(the test Postgres is on 5434; the developer's own Redis, if any, keeps 6379).
`pnpm test:db:up` brings both up.

`.env.test.example` gains **`TEST_REDIS_URL=redis://localhost:6380`**, not
`REDIS_URL`. The name matters: `REDIS_URL` is what `getUsageStore()` reads, so
setting it in `.env.test` would silently switch every handler test onto the
Redis driver and make the whole suite depend on a running container. Only the
contract suite reads `TEST_REDIS_URL`, and it constructs that driver directly
rather than going through the registry. Its Redis half skips with a clear
message when the variable is unset or the connection fails, so `pnpm test`
still passes for someone who has not started the container.

**Window math** is pure functions over an injected `now` — boundary weighting,
the `>` vs `>=` asymmetry, reset seconds — tested without a store at all.

**Handler tests** cover: over rpm → `429` with `Retry-After` and no
`request_logs` row; over budget → `insufficient_quota`; a rejected request not
consuming rpm; a store that throws → request served, no headers, one stderr
line; headers present and correct on a served request; charge applied after a
streaming response completes.

## 14. Files

```
src/lib/usage/types.ts       interface, ops, decision types
src/lib/usage/keys.ts        counter names, bucket + month math
src/lib/usage/memory.ts      Map driver
src/lib/usage/redis.ts       ioredis driver
src/lib/usage/registry.ts    REDIS_URL resolution, status
src/lib/usage/limits.ts      window math, check, charge, headers, 429
src/lib/usage/index.ts       public surface

src/lib/gateway/chat-handler.ts   check before resolve, charge beside log
src/lib/db/schema.ts              drop spend_total_usd (+ migration)
src/lib/admin/keys.ts             usage in the list, clear on delete
src/app/(admin)/keys/page.tsx     Usage column, header text
src/app/(admin)/settings/page.tsx + governance-form.tsx   driver status

package.json                 + ioredis
docker-compose.test.yml      + redis on 6380
.env.example, .env.test.example, README.md
```

## 15. Limitations to document

1. Counters reset when the store loses its data. Budgets are durable only
   against a persistent Redis.
2. In memory mode limits are per instance; `n` replicas allow `n ×` the limit.
3. A key can overshoot by the requests in flight when it crossed its limit.
4. A crash between a rejection's increment and its compensating decrement
   inflates that key's window by one for up to two minutes, then
   self-corrects when the window's TTL expires — the decrement carries the
   same `ttlSeconds` as the increment it undoes, so this is bounded rather
   than a permanent leak even when the decrement runs against an
   already-expired bucket.
5. Limit rejections do not appear on the Logs page.
6. Redis Cluster and Sentinel are neither implemented nor tested.
