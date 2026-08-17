# Target Health and the Circuit Breaker — design

The routing engine (Phase 2) deferred the circuit breaker whole: no breaker
state, no cooldowns, no probes, no `target_health` table. This design builds it,
and puts the state in Redis rather than in Postgres.

## 1. Problem

`selectOrder` builds the attempt chain from configuration alone — priority,
weight, policy, `enabled`. Nothing it reads has any idea whether a target
*worked* thirty seconds ago. So a provider that is hard down is attempted on
every single request until an admin notices and unchecks `enabled` by hand.

The routing spec named the cost precisely (§7):

> **A hard-down provider is re-attempted on every request.** Failover routes
> around it, but each request still pays one wasted upstream call and its
> timeout before moving on. This is precisely the cost the circuit breaker was
> specified to remove, and it is the strongest argument for building it next.

Two things make that worse than it sounds:

1. **The wasted call is charged the full per-attempt timeout.** `attemptContext`
   defaults to `DEFAULT_TIMEOUT_MS = 120_000`. A provider that black-holes
   connections rather than refusing them adds up to two minutes to a request
   that a healthy sibling could have served immediately.
2. **It scales with traffic, not with the outage.** A thousand requests per
   minute means a thousand doomed upstream calls per minute, against a provider
   that is already struggling. The gateway becomes a load generator aimed at the
   thing it is trying to route around.

The original gateway spec (§Circuit breaker) specified the fix as a
`target_health` table keyed by `target_id`, holding `consecutive_failures`, a
`state` enum, `opened_at` and `next_probe_at`. This design keeps the semantics
and moves the storage: the state is high-frequency, purely operational, and
worthless after a restart, which is a description of a cache rather than of a
row. Redis already carries the usage counters for exactly that reason, and
`src/lib/usage/` already establishes the store-with-memory-fallback pattern this
follows.

## 2. Scope

**In:**

- A breaker per **route target**, opened by consecutive failures and closed by a
  cooldown, with half-open probe semantics.
- A `HealthStore` with Redis and in-memory drivers, resolved from `REDIS_URL`
  the way `getUsageStore()` already is.
- Health as an input to `selectOrder`, which stays pure and synchronous.
- Global threshold and cooldown in `settings`, with optional per-target
  overrides on `route_targets`.
- Breaker state and a manual reset on the virtual-model detail page.

**Out, by decision:**

- **Direct `provider/model` addresses are never breakable.** Such a request has
  exactly one possible route, so an open breaker could only convert a request
  that might have succeeded into a guaranteed 503.
- **No exponential or jittered backoff.** One flat cooldown.
- **No active probing.** No background health pings, no scheduler. State moves
  only on real traffic.
- **No `target_health` table.** Health is ephemeral by construction; without
  Redis it is per-process, which is the same trade `rr-cursor.ts` already makes.
- **No provider-level or virtual-model-level rollup**, and no alerting.
- **`rr-cursor.ts` stays in process memory.** Moving it to Redis becomes easy
  once a shared connection module exists, but it is a separate decision.

## 3. Decisions

### Why Redis rather than the `target_health` table

Every write is on the request path and every read is on the request path. A
Postgres row per failed attempt turns a provider outage into write amplification
against the database that also serves the dashboard, the API keys, and the
request logs. The data is also worth nothing an hour later — there is no report
to run over it and no history to keep — so durability buys nothing while costing
a write to disk.

The one thing the table had that Redis does not is a place for an admin to look
when Redis is absent. That is answered by the memory driver plus the Governance
tab naming the active driver, not by keeping a table nobody reads.

### Why key expiry *is* the state machine

The classic breaker carries `state`, `opened_at` and `next_probe_at`, and needs
a clock every reader agrees on plus a rule for which instance runs the probe.
Two keys with TTLs remove all of it:

- `open:<id>` exists ⇒ the breaker is open. Its TTL *is* `next_probe_at`, and
  Redis expiring it *is* the transition to half-open. Every instance agrees
  because they are all reading the same key.
- `fail:<id>` is the consecutive-failure counter, given a TTL of at least twice
  the cooldown. That single rule does two jobs: failures decay on a target that
  has gone quiet, and — because the TTL necessarily outlives `open:<id>` — the
  counter is still sitting at the threshold when the cooldown lapses.

The second half is what makes half-open free. When `open:<id>` expires the
target reads closed and rejoins the chain in its normal position, so the next
request probes it with no election and no scheduler. But `fail:<id>` is still at
the threshold, so a single further failure increments past it and re-opens the
breaker immediately. That is exactly half-open's contract — one probe, and one
failure is enough to re-open — expressed as arithmetic on a counter nobody
reset.

Two instances that cross the threshold simultaneously both `SET open:<id>`. The
write is idempotent and the second one merely refreshes the TTL, so the race
needs no locking. The original spec reached the same conclusion about concurrent
probes: "Harmless, and preferable to locking."

### Why an open breaker demotes rather than excludes

An open breaker sinks a target behind every closed one, but never removes it
from the chain. When every candidate is open the chain is simply every candidate
in ordinary policy order.

Exclusion would mean the gateway declines to attempt a request during a total
outage — precisely when the client most needs it to try — and would turn any
false-positive breaker into a hard failure. Demotion keeps the entire benefit
(with one healthy target present, the broken one is never reached) while making
the worst case "behaves like today" instead of "503s where today it succeeded".

### Why demotion crosses tier boundaries

`select.ts` already contains the opposite rule for zero-weight targets:

> They stay inside the tier because sinking them past a later one would invert
> the order priority exists to express.

An open breaker sinks past later tiers; a zero weight does not. The distinction
is the source of the signal. A weight of 0 is a *configured preference*, and
honouring priority above it respects what the operator asked for. An open
breaker is an *observed fact* — evidence this target is currently failing.
Demoting a target you have evidence is broken below one you have no such
evidence about is not overriding the operator's intent, it is serving it.

Both rules will live in the same file, so the existing comment is rewritten to
say which is which rather than left to look like an inconsistency.

### Why client aborts must not count

`classifyProviderError` maps an `AbortError` to a retryable 504. A caller that
hangs up mid-request produces exactly that, and counting it would open breakers
on targets that never failed — worst on the slow, long-generation requests
clients are most likely to cancel. `execute` already has `clientSignal` in hand
at the point it classifies, so the exclusion costs one condition.

### Why a 4xx is neither a failure nor a success

A non-retryable 4xx means the target answered, so it is not evidence of a broken
target. But clearing the counter on it would let a single malformed request from
one bad client erase four genuine accumulated failures. Recording nothing in
either direction is the only reading that adds no false signal in either
direction.

`createAdapter` failures (501 `unsupported_operation`) are likewise ignored: no
upstream call was made, so there is nothing to protect, and the attempt is
already cheap.

## 4. Architecture

### `src/lib/health/` — the store

Four files mirroring `src/lib/usage/` file-for-file, so the codebase has one
store pattern rather than two: `types.ts`, `redis.ts`, `memory.ts`,
`registry.ts`.

**Key space**, namespaced beside `babellm:usage`:

| Key | Type | Written | TTL |
|---|---|---|---|
| `babellm:health:open:<targetId>` | string `"1"` | on transition to open | `cooldownSeconds` |
| `babellm:health:fail:<targetId>` | counter | every failed attempt | `max(60, cooldownSeconds × 2)` |
| `babellm:health:meta:<targetId>` | hash: `openedAt`, `lastError` | on transition only | as `fail` |

`meta` exists only for the dashboard and is written only when the state changes,
so the request path never touches it.

**Interface.** Two reads, deliberately split, because the request path must not
pay for what only the admin page displays:

```ts
export type BreakerState = 'closed' | 'half_open' | 'open'

/** Facts read out of the store. Deliberately free of any interpretation that
 *  would require the store to know a target's configured threshold. */
export interface TargetHealth {
  open: boolean
  /** Seconds until the open key expires. null unless open. */
  reopensIn: number | null
  consecutiveFailures: number
  openedAt: number | null
  lastError: string | null
}

/** Pure, and the only place the three-state reading is derived. */
export function breakerState(health: TargetHealth, config: BreakerConfig): BreakerState

export interface BreakerConfig {
  /** Consecutive failures required to open. 0 disables the breaker. */
  threshold: number
  cooldownSeconds: number
}

export interface HealthStore {
  readonly name: string
  /** Request path. One MGET over the open keys. */
  openTargets(targetIds: string[]): Promise<Set<string>>
  /** Admin page. Pipelined TTL + GET + HGETALL. */
  details(targetIds: string[]): Promise<Map<string, TargetHealth>>
  fail(targetId: string, config: BreakerConfig, error: string): Promise<void>
  succeed(targetId: string): Promise<void>
  reset(targetId: string): Promise<void>
  status(): StoreStatus
  close?(): Promise<void>
}
```

`half_open` is a *derived* read state, never a stored one: `open` false while
`consecutiveFailures >= threshold`. Deriving it needs the target's effective
threshold, which is configuration the store has no business holding — so the
store returns facts and `breakerState()` interprets them, called from the admin
page where the target row and the settings are both already in hand.
`openTargets` does not distinguish half-open at all, because for ordering
purposes half-open is closed.

**Transitions**, exhaustively:

| Trigger | Commands |
|---|---|
| failure, count below threshold | `INCR fail` + `EXPIRE fail` |
| failure, count reaches threshold | as above, then `SET open EX cooldown` + `HSET meta` |
| success | `DEL open fail` |
| cooldown expires | *nothing runs* — Redis drops `open`, `fail` survives |
| manual reset | `DEL open fail meta` |
| `threshold === 0` | `fail` returns immediately; the breaker is off |

### `src/lib/redis/connection.ts` — extracted, not duplicated

`usage/redis.ts` contains a subtle connection bootstrap: `enableOfflineQueue:
false` so an outage cannot become latency, the mandatory `error` listener
without which an unhandled event kills the process, and the bounded one-shot
`firstConnect` promise that stops the very first command from failing during the
TCP handshake. Copying it into a second driver would copy its future bugs, so it
moves to a shared module returning one client per URL, used by both stores.

This is the only change to existing infrastructure, and it is behaviour-
preserving: the usage store's contract test covers it before and after.

### `resolve.ts` — marking what can break

`Candidate.targetId` is a `route_targets` id for a virtual model and a
`catalog_models` id for a direct address, with nothing distinguishing them. A
`breakable: boolean` field is added — `true` from `findVirtualModel`, `false`
from `resolveDirect`. Selection never treats an unbreakable candidate as open,
and the write path never records health for one.

The per-target overrides ride along at no cost, since `findVirtualModel` already
selects the whole row:

```ts
breakerThreshold: number | null
breakerCooldownSeconds: number | null
```

### `select.ts` — partition, then tier

`selectOrder` stays pure and synchronous; health arrives as data, exactly as
`random` and `nextCursor` already do:

```ts
export interface SelectDeps {
  random: () => number
  nextCursor: (virtualModelId: string) => number
  /** Target ids whose breaker is open. Empty when health is unavailable. */
  open: ReadonlySet<string>
}
```

`selectOrder` already takes `Partial<SelectDeps>` and fills its own defaults, so
`open` defaults to an empty set. Every existing call site and test keeps working
untouched, and "no health information" is spelled the same way as "nothing is
open" — which is the fail-open behaviour, expressed in the type rather than in a
branch.

The existing body — `tiersOf`, `weightedOrder`, `rotate` — is untouched. It just
runs twice, once per partition:

```ts
const isOpen = (c: Candidate) => c.breakable && open.has(c.targetId)

// The existing body, lifted verbatim into a function so it can run per
// partition. `cursor` is still read once per request, above this point.
const arrange = (cs: Candidate[]) =>
  tiersOf(cs).flatMap((tier) =>
    model.policy === 'weighted' ? weightedOrder(tier, random)
    : model.policy === 'round_robin' ? rotate(tier, cursor)
    : tier,
  )

const ordered = [
  ...arrange(candidates.filter((c) => !isOpen(c))),
  ...arrange(candidates.filter(isOpen)),
]
return ordered.slice(0, Math.max(1, model.maxAttempts))
```

Consequences, all of which fall out rather than being special-cased:

- One target down: it sits in the tail, a healthy target serves first, and the
  wasted upstream call is gone.
- Every target open: the healthy partition is empty and the chain is the full
  candidate list in ordinary policy order.
- `maxAttempts` still slices the flattened chain, now spending its budget on
  healthy targets first.
- Round robin reads its cursor once per request and shares it across both
  partitions. The rotation position shifts as targets open and close; round
  robin's guarantee is spread, not an exact sequence.

### `chat-handler.ts` — the read, and failing open

```ts
const { model, candidates } = await resolveModel(body.model)
const open = await openTargetsFor(candidates)   // never throws
const chain = selectOrder(candidates, model, { open })
```

`openTargetsFor` returns an empty set on any error, so routing degrades to
today's behaviour and never to something worse. One extra Redis round trip per
request, necessarily sequential after `resolveModel` (the target ids do not
exist before it), bounded by the existing `commandTimeout: 250`.

### `execute.ts` — the write

One new optional dependency, no new control flow:

```ts
export interface ExecuteDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
  recordHealth?: (candidate: Candidate, outcome: 'success' | 'failure', error?: string) => void
}
```

Fire-and-forget throughout, the same discipline as `touchApiKey` and
`emitRequestLog`: `void store.fail(...).catch(console.error)`. Health
bookkeeping must never add latency to a response or fail a request that already
succeeded.

`execute` is handed a `recordHealth` that already knows how to resolve config,
rather than a `BreakerConfig` — the loop has no business reading settings.
`chat-handler` builds it from the candidate's own `breakerThreshold` /
`breakerCooldownSeconds`, falling back per-field to the cached globals, so a
target may override one and inherit the other.

| Branch in `execute` | Recorded |
|---|---|
| `run` resolves | `success` |
| retryable error, client connected | `failure` |
| retryable error, `clientSignal.aborted` | nothing |
| non-retryable 4xx | nothing |
| `createAdapter` throws (501) | nothing |
| candidate not `breakable` | nothing |

### Configuration

The effective threshold and cooldown are needed **only on the write path** — the
read path wants nothing but the open set — so no settings lookup is on the
request-critical path.

Migration, both columns nullable, `NULL` meaning inherit:

```sql
ALTER TABLE route_targets
  ADD COLUMN breaker_threshold integer,
  ADD COLUMN breaker_cooldown_seconds integer;
```

Globals follow the existing `getCatalogSettings` / `getLoggingSettings` shape —
`getRoutingSettings()` and `setRoutingSettings()` over `routing.breaker_threshold`
and `routing.breaker_cooldown_seconds`, defaulting to the original spec's **5
failures / 30 seconds**. A short in-process TTL cache (10s), busted directly by
the save action, keeps a burst of failures from becoming a burst of Postgres
reads; other instances converge within the TTL, which is acceptable for a tuning
knob.

Validation: `threshold >= 0`, `cooldownSeconds >= 1`. **`threshold: 0` disables
the breaker** — globally, or on a single target that should always be attempted.
This is the escape hatch when a breaker misbehaves in production, and it costs
one early return.

### Dashboard

On `/models/[id]`, whose target table already renders `Badge`s and is
`force-dynamic`:

- A **Health** column between *Enabled* and the row actions, fed by one
  `details()` call for the page's targets. `closed` renders no badge, keeping
  the table quiet in the normal case; `open` is `destructive`, reading
  **open · 24s** from `reopensIn`; `half_open` is `outline`. `lastError` is the
  title attribute.
- **Reset breaker** joins the existing `TargetRowActions` dropdown, calling a
  server action behind `requireAdmin()` that runs `reset(targetId)` and
  `revalidatePath`. It is disabled when the target reads closed, so it is never
  a no-op that looks like one.
- `edit-target-form.tsx` gains the two override fields, blank meaning inherit,
  with the effective global as the placeholder.
- The Settings page gains the two globals beside Governance, and
  `usage-status.tsx` extends to name the health driver as well — "memory" there
  silently means per-instance breakers, which an operator needs to see.

## 5. Failure modes

| Situation | Behaviour |
|---|---|
| Redis unreachable | `openTargets` yields an empty set, `fail`/`succeed` reject and are swallowed. Routing is identical to today. Governance shows the driver unhealthy. |
| `REDIS_URL` unset | Memory driver. Breakers work per-process, like `rr-cursor.ts` today. |
| Every target open | Full chain in policy order. One wasted call per attempt returns, only during a total outage. |
| Breaker opened by a false positive | Target is demoted, not removed; it is still attempted when healthier targets fail, and clears on the first success. |
| Two instances cross the threshold together | Both `SET open`; idempotent, the second refreshes the TTL. |
| Clock skew between instances | Irrelevant. Expiry is Redis-side; no instance compares timestamps. |

## 6. Known limitations

- **Stream failures after the first chunk do not count.** `run` pulls the first
  chunk, so success is recorded there rather than at stream end. This is the
  boundary failover already uses, and moving one without the other would be
  worse than leaving both.
- **Health is per-process without Redis.** Three instances on the memory driver
  each learn a target is down separately, so an outage costs up to three wasted
  calls per cooldown rather than one.
- **A target that recovers is discovered lazily.** Nothing probes; recovery
  requires a request to reach the target, which under demotion means the healthy
  targets must fail first or the cooldown must lapse.
- **Global settings propagate within the cache TTL**, so a threshold change
  takes up to 10 seconds to reach every instance.

## 7. Testing

- **A shared store contract** (`tests/lib/health/store-contract.ts`) run against
  both drivers, mirroring `tests/lib/usage/store-contract.ts`, with the Redis
  run gated on `TEST_REDIS_URL` so a fresh checkout passes with no container.
  `.env.test.example` continues to withhold `REDIS_URL` for the same reason it
  does today: the health registry reads it, and setting it would put the whole
  suite on the Redis driver.
- **The half-open sequence is the contract's centrepiece**: open a breaker, let
  the cooldown lapse, assert the target reads closed, then assert that *one*
  failure re-opens it. These use a 1-second cooldown and genuinely wait it out —
  the Redis driver's behaviour here *is* key expiry, so a faked clock would test
  something other than the design.
- **`select.test.ts`** covers ordering as pure data with no store: open sinks
  behind healthy across a tier boundary, all-open degrades to the full chain,
  `maxAttempts` slices the partitioned chain, an unbreakable candidate is never
  treated as open, and round robin still spreads across a partitioned tier.
- **`execute.test.ts`** pins every row of the recording table above, including
  the aborted-client case.
- **One gateway-level test** that a breaker opened by earlier requests routes
  around a down provider with *zero* attempts against it — the behaviour the
  whole design promises.
- **One fail-open test**: a store whose every method rejects leaves routing
  byte-identical to today.
