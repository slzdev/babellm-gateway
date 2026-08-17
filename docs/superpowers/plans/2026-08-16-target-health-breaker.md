# Target Health Circuit Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-attempting a hard-down route target on every request by giving each target a Redis-backed circuit breaker that demotes it in the attempt chain until it recovers.

**Architecture:** A `HealthStore` (Redis driver, in-memory fallback) records consecutive failures per route target and sets an open marker whose TTL *is* the cooldown. `selectOrder` stays pure and receives the set of open target ids, partitioning candidates into healthy-then-broken before applying the existing tier/policy ordering. `execute` records success and failure fire-and-forget. Half-open needs no state: the open marker expires while the failure counter (given a longer TTL) survives at the threshold, so the target rejoins the chain and one further failure re-opens it.

**Tech Stack:** TypeScript, Next.js 16, ioredis 5.9, drizzle-orm, Postgres, vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-16-target-health-breaker-design.md`

## Global Constraints

- **Never point tests at port 5432.** `.env.test` must keep `DATABASE_URL=postgres://babellm:babellm@localhost:5434/babellm_test_breaker`. Never run `pnpm test:db:down` — it destroys the test containers of every worktree at once.
- **Never set `REDIS_URL` in `.env.test`.** The health registry reads it, and setting it would put the entire suite on the Redis driver. Redis-backed tests read `TEST_REDIS_URL=redis://localhost:6380` and skip when it is absent.
- **Defaults, verbatim from the spec:** threshold `5` consecutive failures, cooldown `30` seconds, failure-counter TTL `max(60, cooldownSeconds * 2)` seconds, settings cache TTL `10_000` ms.
- **`threshold === 0` disables the breaker** — globally or per target.
- **Validation:** `threshold >= 0`, `cooldownSeconds >= 1`.
- **Fail open, always.** Any health-store error must leave routing byte-identical to today. No health call may throw into the request path.
- **UI is shadcn/ui.** Compose from `src/components/ui/`; do not hand-roll markup that duplicates it.
- **Run the full suite before every commit:** `pnpm test`. Baseline is 88 files / 1009 tests passing.

---

### Task 1: Extract the shared Redis connection

`src/lib/usage/redis.ts` holds a subtle connection bootstrap that the health driver needs too. Copying it would copy its future bugs. This task moves it and rewires the usage store — behaviour-preserving, proven by the existing usage contract test.

**Files:**
- Create: `src/lib/redis/connection.ts`
- Modify: `src/lib/usage/redis.ts` (replace lines 1–53 and `status`/`close` internals)
- Test: `tests/lib/redis/connection.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RedisConnection {
    readonly client: import('ioredis').default
    /** Resolves once the first connect attempt has settled, or after 1s.
     *  Null after it settles, so later outages fail fast with no added wait. */
    ready(): Promise<void> | null
    status(): { healthy: boolean; error: string | null }
    close(): void
  }
  export function getRedisConnection(url: string): RedisConnection
  export function resetRedisConnections(): void
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/redis/connection.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { getRedisConnection, resetRedisConnections } from '@/lib/redis/connection'

const url = process.env.TEST_REDIS_URL

afterEach(() => {
  resetRedisConnections()
})

test.skipIf(!url)('the same url yields the same client', () => {
  const a = getRedisConnection(url!)
  const b = getRedisConnection(url!)
  expect(a.client).toBe(b.client)
})

test.skipIf(!url)('ready() settles and then reports null', async () => {
  const conn = getRedisConnection(url!)
  await conn.ready()
  expect(conn.ready()).toBeNull()
  expect(conn.status()).toEqual({ healthy: true, error: null })
})

test('an unreachable server resolves rather than throwing', async () => {
  // Port 1 has nothing on it. A boot with Redis down must resolve so the
  // caller's fail-open path handles it, never reject into the request path.
  const conn = getRedisConnection('redis://127.0.0.1:1')
  await expect(conn.ready()).resolves.toBeUndefined()
  expect(conn.status().healthy).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/redis/connection.test.ts`
Expected: FAIL — `Cannot find module '@/lib/redis/connection'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/redis/connection.ts`. Move the comments across with the code — they explain non-obvious choices and are the reason this is being extracted rather than duplicated:

```ts
import Redis from 'ioredis'

export interface RedisConnection {
  readonly client: Redis
  ready(): Promise<void> | null
  status(): { healthy: boolean; error: string | null }
  close(): void
}

const connections = new Map<string, RedisConnection>()

/**
 * One client per URL, shared by every store that needs Redis.
 *
 * Shared rather than one client per store because this bootstrap is subtle —
 * see the three comments below — and a second hand-copied version of it would
 * be a second place for the same bug to be fixed only once.
 */
export function getRedisConnection(url: string): RedisConnection {
  const existing = connections.get(url)
  if (existing) return existing

  const client = new Redis(url, {
    // Fail fast rather than queue. With the offline queue on, a command
    // issued while Redis is unreachable waits for reconnection instead of
    // rejecting — which would turn a Redis outage into gateway latency,
    // the exact thing failing open exists to prevent.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    connectTimeout: 1000,
  })

  let lastError: string | null = null

  // ioredis emits 'error' on every failed connection attempt, and an
  // unhandled 'error' event takes the process down. This listener is not
  // optional.
  client.on('error', (err: Error) => {
    lastError = err.message
  })
  client.on('ready', () => {
    lastError = null
  })

  // The TCP handshake takes a few milliseconds, and with enableOfflineQueue:
  // false a command issued before it completes rejects immediately instead
  // of waiting. A caller that builds a store and uses it in the same tick —
  // which is exactly what a contract test does, and what a gateway could do
  // at boot if the first request arrives fast enough — would otherwise fail
  // its very first command every time, not just on rare bad luck. This waits
  // once, bounded by connectTimeout, for the first `ready`, and it never
  // rejects: a boot with Redis down must resolve, not throw, so the caller's
  // normal fail-open path handles it from there. Unlike the offline queue,
  // this is one-time and bounded — `firstConnect` is nulled out the instant
  // it settles, so a later live outage after the first connect skips this
  // entirely and fails fast with no added latency.
  let resolveFirstConnect: (() => void) | undefined
  let firstConnect: Promise<void> | null = new Promise((resolve) => {
    resolveFirstConnect = resolve
  })
  const timer = setTimeout(() => {
    firstConnect = null
    resolveFirstConnect?.()
  }, 1000)
  client.once('ready', () => {
    clearTimeout(timer)
    firstConnect = null
    resolveFirstConnect?.()
  })

  const connection: RedisConnection = {
    client,
    ready: () => firstConnect,
    status() {
      const healthy = client.status === 'ready' && lastError === null
      // `error` is reserved for an actual failure — the `error` listener
      // above is the only thing that sets `lastError`. Everything else that
      // isn't `ready` (dialing for the first time, reconnecting after a
      // clean close, ...) is "not there yet", not "broken", and must read
      // that way: a caller mid-boot with a healthy Redis would otherwise see
      // the raw ioredis status string (e.g. "connecting") rendered as an
      // error.
      return { healthy, error: healthy ? null : lastError }
    },
    close() {
      clearTimeout(timer)
      // If close() runs before `ready` and before the timer fires, nothing
      // else will ever settle `firstConnect`: the timer that would have
      // resolved it is now cancelled, and a disconnected client never emits
      // `ready`. Without this, any command already waiting — or issued
      // after — would await forever, which is exactly the unbounded latency
      // this whole mechanism exists to avoid.
      firstConnect = null
      resolveFirstConnect?.()
      connections.delete(url)
      client.disconnect()
    },
  }

  connections.set(url, connection)
  return connection
}

/** Tests only. Drops every cached connection. */
export function resetRedisConnections(): void {
  for (const connection of [...connections.values()]) connection.close()
  connections.clear()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/redis/connection.test.ts`
Expected: PASS (3 tests, or 1 passed + 2 skipped without `TEST_REDIS_URL`).

- [ ] **Step 5: Rewire the usage store onto it**

Rewrite `src/lib/usage/redis.ts` so it holds no connection logic. Replace everything above `return {` with:

```ts
import { getRedisConnection } from '@/lib/redis/connection'
import type { CounterOp, StoreStatus, UsageStore } from './types'

export function createRedisStore(url: string): UsageStore {
  const connection = getRedisConnection(url)
  const redis = connection.client
```

Then inside the returned object, replace each `if (firstConnect) await firstConnect` with `await connection.ready()` (awaiting `null` is a no-op, so the guard is no longer needed), replace the `status()` body with `return connection.status()`, and replace the `close()` body with `connection.close()`.

- [ ] **Step 6: Verify the usage store still honours its contract**

Run: `pnpm vitest run tests/lib/usage/`
Expected: PASS, same count as before the change. This is the proof the extraction is behaviour-preserving.

- [ ] **Step 7: Run the full suite and commit**

```bash
pnpm test
git add src/lib/redis/connection.ts src/lib/usage/redis.ts tests/lib/redis/connection.test.ts
git commit -m "refactor(redis): share one connection bootstrap between stores"
```

---

### Task 2: Health store types, keys, and the pure breaker policy

No I/O in this task — the shapes and the two pure functions everything else depends on.

**Files:**
- Create: `src/lib/health/types.ts`, `src/lib/health/keys.ts`, `src/lib/health/breaker.ts`
- Test: `tests/lib/health/breaker.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // types.ts
  export type BreakerState = 'closed' | 'half_open' | 'open'
  export interface BreakerConfig { threshold: number; cooldownSeconds: number }
  export interface TargetHealth {
    open: boolean
    reopensIn: number | null
    consecutiveFailures: number
    openedAt: number | null
    lastError: string | null
  }
  export interface StoreStatus { healthy: boolean; error: string | null }
  export interface HealthStore {
    readonly name: string
    openTargets(targetIds: string[]): Promise<Set<string>>
    details(targetIds: string[]): Promise<Map<string, TargetHealth>>
    fail(targetId: string, config: BreakerConfig, error: string): Promise<void>
    succeed(targetId: string): Promise<void>
    reset(targetId: string): Promise<void>
    status(): StoreStatus
    close?(): Promise<void>
  }
  export const CLOSED: TargetHealth

  // keys.ts
  export const PREFIX = 'babellm:health'
  export function openKey(targetId: string): string
  export function failKey(targetId: string): string
  export function metaKey(targetId: string): string
  export const MIN_FAIL_TTL_SECONDS = 60
  export function failTtlSeconds(cooldownSeconds: number): number
  export const MAX_ERROR_LENGTH = 300
  export function truncateError(message: string): string

  // breaker.ts
  export const DEFAULT_THRESHOLD = 5
  export const DEFAULT_COOLDOWN_SECONDS = 30
  export function breakerState(health: TargetHealth, config: BreakerConfig): BreakerState
  export function resolveBreakerConfig(
    overrides: { breakerThreshold: number | null; breakerCooldownSeconds: number | null },
    globals: BreakerConfig,
  ): BreakerConfig
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/health/breaker.test.ts`:

```ts
import { expect, test } from 'vitest'
import { breakerState, resolveBreakerConfig } from '@/lib/health/breaker'
import { failTtlSeconds, truncateError } from '@/lib/health/keys'
import { CLOSED, type TargetHealth } from '@/lib/health/types'

const health = (patch: Partial<TargetHealth> = {}): TargetHealth => ({ ...CLOSED, ...patch })
const config = { threshold: 5, cooldownSeconds: 30 }

test('a target with no keys reads closed', () => {
  expect(breakerState(CLOSED, config)).toBe('closed')
})

test('an open marker reads open regardless of the counter', () => {
  expect(breakerState(health({ open: true, reopensIn: 12, consecutiveFailures: 5 }), config))
    .toBe('open')
})

test('failures below the threshold still read closed', () => {
  expect(breakerState(health({ consecutiveFailures: 4 }), config)).toBe('closed')
})

test('a loaded counter with no marker is the half-open probation window', () => {
  // The marker expired but the counter outlived it — the target is back in
  // the chain, and one more failure re-opens it.
  expect(breakerState(health({ consecutiveFailures: 5 }), config)).toBe('half_open')
})

test('a disabled breaker never reads anything but closed', () => {
  expect(breakerState(health({ consecutiveFailures: 99 }), { threshold: 0, cooldownSeconds: 30 }))
    .toBe('closed')
})

test('overrides apply per field, so one can be set and the other inherited', () => {
  expect(resolveBreakerConfig({ breakerThreshold: 2, breakerCooldownSeconds: null }, config))
    .toEqual({ threshold: 2, cooldownSeconds: 30 })
  expect(resolveBreakerConfig({ breakerThreshold: null, breakerCooldownSeconds: 5 }, config))
    .toEqual({ threshold: 5, cooldownSeconds: 5 })
})

test('a per-target threshold of 0 disables the breaker for that target alone', () => {
  expect(resolveBreakerConfig({ breakerThreshold: 0, breakerCooldownSeconds: null }, config))
    .toEqual({ threshold: 0, cooldownSeconds: 30 })
})

test('the failure counter always outlives the open marker', () => {
  // This is what makes half-open free, so it is pinned rather than assumed.
  for (const cooldown of [1, 5, 30, 300, 3600]) {
    expect(failTtlSeconds(cooldown)).toBeGreaterThan(cooldown)
  }
  expect(failTtlSeconds(30)).toBe(60)
  expect(failTtlSeconds(300)).toBe(600)
})

test('error messages are capped so the meta hash stays small', () => {
  expect(truncateError('x'.repeat(500))).toHaveLength(300)
  expect(truncateError('short')).toBe('short')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/health/breaker.test.ts`
Expected: FAIL — `Cannot find module '@/lib/health/breaker'`.

- [ ] **Step 3: Write `src/lib/health/types.ts`**

```ts
/** How a target's breaker reads. `half_open` is derived, never stored. */
export type BreakerState = 'closed' | 'half_open' | 'open'

export interface BreakerConfig {
  /** Consecutive failures required to open. 0 disables the breaker. */
  threshold: number
  cooldownSeconds: number
}

/**
 * Facts read out of the store.
 *
 * Deliberately free of any interpretation that would require the store to
 * know a target's configured threshold — that is configuration, and a driver
 * has no idea what a route target is. `breakerState()` does the interpreting.
 */
export interface TargetHealth {
  open: boolean
  /** Seconds until the open marker expires. null unless open. */
  reopensIn: number | null
  consecutiveFailures: number
  openedAt: number | null
  lastError: string | null
}

/** A target with no keys at all. Absence of state is health, not unknown. */
export const CLOSED: TargetHealth = {
  open: false,
  reopensIn: null,
  consecutiveFailures: 0,
  openedAt: null,
  lastError: null,
}

export interface StoreStatus {
  healthy: boolean
  error: string | null
}

export interface HealthStore {
  readonly name: string
  /**
   * The request path's only read: which of these targets are currently open.
   * One round trip, and no interpretation — half-open is closed for ordering.
   */
  openTargets(targetIds: string[]): Promise<Set<string>>
  /** The admin page's read. Targets with no state are absent from the map. */
  details(targetIds: string[]): Promise<Map<string, TargetHealth>>
  /** Records a failed attempt, opening the breaker when the count reaches
   *  `config.threshold`. A threshold of 0 makes this a no-op. */
  fail(targetId: string, config: BreakerConfig, error: string): Promise<void>
  succeed(targetId: string): Promise<void>
  /** Manual reset from the dashboard: forget everything about this target. */
  reset(targetId: string): Promise<void>
  status(): StoreStatus
  close?(): Promise<void>
}
```

- [ ] **Step 4: Write `src/lib/health/keys.ts`**

```ts
/** Namespaced beside `babellm:usage` so a shared Redis stays legible. */
export const PREFIX = 'babellm:health'

/** Exists ⇒ the breaker is open. Its TTL is the cooldown, which makes Redis
 *  itself the clock every instance agrees on. */
export const openKey = (targetId: string) => `${PREFIX}:open:${targetId}`

/** Consecutive failures. */
export const failKey = (targetId: string) => `${PREFIX}:fail:${targetId}`

/** Display-only: openedAt and lastError, written on transition only so the
 *  request path never touches it. */
export const metaKey = (targetId: string) => `${PREFIX}:meta:${targetId}`

/** Floor, so a short cooldown still lets failures accumulate across a gap
 *  between requests rather than decaying between two of them. */
export const MIN_FAIL_TTL_SECONDS = 60

/**
 * One rule doing two jobs.
 *
 * It decays stale failures on a target that has gone quiet; and because it is
 * always strictly greater than the cooldown, the counter is still sitting at
 * the threshold when the open marker expires. That is what makes half-open
 * free: the target rejoins the chain, and one further failure increments past
 * the threshold and re-opens it immediately.
 */
export function failTtlSeconds(cooldownSeconds: number): number {
  return Math.max(MIN_FAIL_TTL_SECONDS, cooldownSeconds * 2)
}

export const MAX_ERROR_LENGTH = 300

/** An upstream can return a very long message; the hash is display-only and
 *  a badge tooltip cannot show more than this anyway. */
export function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message
}
```

- [ ] **Step 5: Write `src/lib/health/breaker.ts`**

```ts
import type { BreakerConfig, BreakerState, TargetHealth } from './types'

/** The original gateway spec's defaults. */
export const DEFAULT_THRESHOLD = 5
export const DEFAULT_COOLDOWN_SECONDS = 30

/**
 * The three-state reading, derived rather than stored.
 *
 * `half_open` is "the marker expired but the counter did not" — the probation
 * window in which the target is back in the chain and a single failure will
 * re-open it. Only this function knows that, because only a caller holding the
 * target's effective config can compare against a threshold.
 */
export function breakerState(health: TargetHealth, config: BreakerConfig): BreakerState {
  if (config.threshold <= 0) return 'closed'
  if (health.open) return 'open'
  return health.consecutiveFailures >= config.threshold ? 'half_open' : 'closed'
}

/**
 * Per field, not per row: a target may pin a hair-trigger threshold and still
 * inherit the global cooldown.
 *
 * 0 is a real value here — it means "never open this target" — so the check is
 * for null, not for falsiness.
 */
export function resolveBreakerConfig(
  overrides: { breakerThreshold: number | null; breakerCooldownSeconds: number | null },
  globals: BreakerConfig,
): BreakerConfig {
  return {
    threshold: overrides.breakerThreshold ?? globals.threshold,
    cooldownSeconds: overrides.breakerCooldownSeconds ?? globals.cooldownSeconds,
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/health/breaker.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
pnpm test
git add src/lib/health tests/lib/health
git commit -m "feat(health): breaker key space and pure state derivation"
```

---

### Task 3: The shared driver contract and the in-memory driver

The contract is written before either driver so both are held to one definition. Its centrepiece is the half-open sequence — the design's whole claim.

**Files:**
- Create: `src/lib/health/memory.ts`
- Test: `tests/lib/health/store-contract.ts`, `tests/lib/health/memory.test.ts` (create)

**Interfaces:**
- Consumes: `HealthStore`, `BreakerConfig`, `CLOSED` from Task 2; `failTtlSeconds`, `truncateError` from Task 2.
- Produces:
  ```ts
  export function createMemoryHealthStore(): HealthStore   // name: 'memory'
  export function describeHealthStoreContract(name: string, create: () => HealthStore): void
  ```

- [ ] **Step 1: Write the contract**

Create `tests/lib/health/store-contract.ts`. Note `k()` namespaces every target id by driver and pid, so a shared Redis cannot leak state between runs — the same guard `tests/lib/usage/store-contract.ts` uses:

```ts
import { afterAll, expect, test } from 'vitest'
import type { BreakerConfig, HealthStore } from '@/lib/health/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The behaviour every driver must have, run once per driver.
 *
 * The drivers are only interchangeable if they agree, and two separately
 * written test files drift.
 */
export function describeHealthStoreContract(name: string, create: () => HealthStore) {
  const store = create()
  const ns = `test:${name}:${process.pid}`
  const k = (suffix: string) => `${ns}:${suffix}`
  const config: BreakerConfig = { threshold: 2, cooldownSeconds: 1 }

  afterAll(async () => {
    await store.close?.()
  })

  test(`${name}: an unknown target is closed and absent from details`, async () => {
    const id = k('unknown')
    expect(await store.openTargets([id])).toEqual(new Set())
    expect(await store.details([id]).then((m) => m.get(id))).toBeUndefined()
  })

  test(`${name}: reading no targets makes no request`, async () => {
    // A model whose candidates are all direct addresses passes an empty list.
    // MGET with zero keys is an error in Redis, so this must short-circuit.
    expect(await store.openTargets([])).toEqual(new Set())
    expect(await store.details([])).toEqual(new Map())
  })

  test(`${name}: failures below the threshold do not open the breaker`, async () => {
    const id = k('below')
    await store.fail(id, config, 'boom')
    expect(await store.openTargets([id])).toEqual(new Set())
    const health = (await store.details([id])).get(id)
    expect(health?.open).toBe(false)
    expect(health?.consecutiveFailures).toBe(1)
  })

  test(`${name}: reaching the threshold opens the breaker`, async () => {
    const id = k('open')
    await store.fail(id, config, 'upstream exploded')
    await store.fail(id, config, 'upstream exploded')

    expect(await store.openTargets([id])).toEqual(new Set([id]))
    const health = (await store.details([id])).get(id)
    expect(health?.open).toBe(true)
    expect(health?.consecutiveFailures).toBe(2)
    expect(health?.lastError).toBe('upstream exploded')
    expect(health?.openedAt).toBeGreaterThan(0)
    expect(health?.reopensIn).toBeGreaterThan(0)
    expect(health?.reopensIn).toBeLessThanOrEqual(config.cooldownSeconds)
  })

  test(`${name}: success clears the counter and the marker`, async () => {
    const id = k('success')
    await store.fail(id, config, 'boom')
    await store.fail(id, config, 'boom')
    expect(await store.openTargets([id])).toEqual(new Set([id]))

    await store.succeed(id)
    expect(await store.openTargets([id])).toEqual(new Set())
    expect((await store.details([id])).get(id)?.consecutiveFailures ?? 0).toBe(0)
  })

  test(`${name}: a threshold of 0 disables the breaker entirely`, async () => {
    const id = k('disabled')
    const off: BreakerConfig = { threshold: 0, cooldownSeconds: 1 }
    await store.fail(id, off, 'boom')
    await store.fail(id, off, 'boom')
    await store.fail(id, off, 'boom')
    expect(await store.openTargets([id])).toEqual(new Set())
    expect((await store.details([id])).get(id)).toBeUndefined()
  })

  test(`${name}: manual reset forgets the target`, async () => {
    const id = k('reset')
    await store.fail(id, config, 'boom')
    await store.fail(id, config, 'boom')
    await store.reset(id)
    expect(await store.openTargets([id])).toEqual(new Set())
    expect((await store.details([id])).get(id)).toBeUndefined()
  })

  test(`${name}: openTargets answers for a mixed batch in one call`, async () => {
    const down = k('mixed-down')
    const up = k('mixed-up')
    await store.fail(down, config, 'boom')
    await store.fail(down, config, 'boom')
    await store.fail(up, config, 'boom')

    expect(await store.openTargets([up, down])).toEqual(new Set([down]))
  })

  // The design's central claim, and the only test that must wait on real time:
  // this driver's half-open behaviour *is* key expiry, so a faked clock would
  // be testing something other than the thing shipped.
  test(`${name}: the cooldown lapses to half-open, and one failure re-opens`, async () => {
    const id = k('half-open')
    await store.fail(id, config, 'boom')
    await store.fail(id, config, 'boom')
    expect(await store.openTargets([id])).toEqual(new Set([id]))

    await sleep(config.cooldownSeconds * 1000 + 250)

    // The marker expired: the target is back in the chain and will be probed.
    expect(await store.openTargets([id])).toEqual(new Set())
    // But the counter outlived it, still standing at the threshold.
    expect((await store.details([id])).get(id)?.consecutiveFailures).toBe(2)

    // So a single further failure re-opens immediately — one probe, one
    // failure, re-opened. No scheduler, no elected prober.
    await store.fail(id, config, 'boom again')
    expect(await store.openTargets([id])).toEqual(new Set([id]))
  }, 10_000)

  test(`${name}: a successful probe after the cooldown clears the counter`, async () => {
    const id = k('recovery')
    await store.fail(id, config, 'boom')
    await store.fail(id, config, 'boom')
    await sleep(config.cooldownSeconds * 1000 + 250)

    await store.succeed(id)
    expect(await store.openTargets([id])).toEqual(new Set())
    expect((await store.details([id])).get(id)?.consecutiveFailures ?? 0).toBe(0)
  }, 10_000)

  test(`${name}: status reports the driver as usable`, () => {
    expect(store.status()).toEqual({ healthy: true, error: null })
  })
}
```

- [ ] **Step 2: Point the memory driver's test file at the contract**

Create `tests/lib/health/memory.test.ts`:

```ts
import { createMemoryHealthStore } from '@/lib/health/memory'
import { describeHealthStoreContract } from './store-contract'

describeHealthStoreContract('memory', () => createMemoryHealthStore())
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/health/memory.test.ts`
Expected: FAIL — `Cannot find module '@/lib/health/memory'`.

- [ ] **Step 4: Write `src/lib/health/memory.ts`**

```ts
import { failTtlSeconds, truncateError } from './keys'
import type { BreakerConfig, HealthStore, StoreStatus, TargetHealth } from './types'

interface Entry {
  failures: number
  /** Epoch ms the failure counter expires. */
  failuresExpireAt: number
  /** Epoch ms the open marker expires, or null when the breaker is closed. */
  openUntil: number | null
  openedAt: number | null
  lastError: string | null
}

/** Entries are dropped on read once expired, but a target that stops being
 *  used is never read again — hence a sweep, purely for memory hygiene. */
const SWEEP_INTERVAL_MS = 60_000

/**
 * The single-instance driver.
 *
 * Breakers are per process here, exactly as `rr-cursor.ts` cursors are. Three
 * instances each learn a target is down separately, so an outage costs up to
 * three wasted calls per cooldown rather than one — the trade for running
 * without Redis, and why the Governance tab names the active driver.
 */
export function createMemoryHealthStore(): HealthStore {
  const entries = new Map<string, Entry>()

  /** Reads through expiry, the way Redis does: an entry past its time is
   *  indistinguishable from one that never existed. */
  function live(targetId: string, now: number): Entry | undefined {
    const entry = entries.get(targetId)
    if (!entry) return undefined
    if (entry.failuresExpireAt <= now) {
      entries.delete(targetId)
      return undefined
    }
    // The marker expires independently of, and before, the counter. That gap
    // is the half-open window.
    if (entry.openUntil !== null && entry.openUntil <= now) entry.openUntil = null
    return entry
  }

  function view(entry: Entry, now: number): TargetHealth {
    return {
      open: entry.openUntil !== null,
      reopensIn: entry.openUntil === null ? null : Math.ceil((entry.openUntil - now) / 1000),
      consecutiveFailures: entry.failures,
      openedAt: entry.openedAt,
      lastError: entry.lastError,
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (entry.failuresExpireAt <= now) entries.delete(id)
    }
  }, SWEEP_INTERVAL_MS)
  // Never hold the process open for bookkeeping.
  sweep.unref()

  return {
    name: 'memory',

    async openTargets(targetIds: string[]): Promise<Set<string>> {
      const now = Date.now()
      const open = new Set<string>()
      for (const id of targetIds) {
        if (live(id, now)?.openUntil != null) open.add(id)
      }
      return open
    },

    async details(targetIds: string[]): Promise<Map<string, TargetHealth>> {
      const now = Date.now()
      const map = new Map<string, TargetHealth>()
      for (const id of targetIds) {
        const entry = live(id, now)
        if (entry) map.set(id, view(entry, now))
      }
      return map
    },

    async fail(targetId: string, config: BreakerConfig, error: string): Promise<void> {
      if (config.threshold <= 0) return
      const now = Date.now()
      const entry = live(targetId, now) ?? {
        failures: 0, failuresExpireAt: 0, openUntil: null, openedAt: null, lastError: null,
      }

      entry.failures += 1
      // Refreshed on every failure, exactly as the Redis EXPIRE is.
      entry.failuresExpireAt = now + failTtlSeconds(config.cooldownSeconds) * 1000

      if (entry.failures >= config.threshold) {
        entry.openUntil = now + config.cooldownSeconds * 1000
        entry.openedAt = now
        entry.lastError = truncateError(error)
      }

      entries.set(targetId, entry)
    },

    async succeed(targetId: string): Promise<void> {
      entries.delete(targetId)
    },

    async reset(targetId: string): Promise<void> {
      entries.delete(targetId)
    },

    status(): StoreStatus {
      // A Map cannot be unreachable.
      return { healthy: true, error: null }
    },

    async close(): Promise<void> {
      clearInterval(sweep)
      entries.clear()
    },
  }
}
```

- [ ] **Step 5: Run the contract against it**

Run: `pnpm vitest run tests/lib/health/memory.test.ts`
Expected: PASS (11 tests). Two of them wait out a 1-second cooldown, so the file takes ~3s.

- [ ] **Step 6: Commit**

```bash
pnpm test
git add src/lib/health/memory.ts tests/lib/health/store-contract.ts tests/lib/health/memory.test.ts
git commit -m "feat(health): in-memory breaker driver and the shared store contract"
```

---

### Task 4: The Redis driver

**Files:**
- Create: `src/lib/health/redis.ts`
- Test: `tests/lib/health/redis.test.ts` (create)

**Interfaces:**
- Consumes: `getRedisConnection` (Task 1); keys and types (Task 2); `describeHealthStoreContract` (Task 3).
- Produces: `export function createRedisHealthStore(url: string): HealthStore` — `name: 'redis'`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/health/redis.test.ts`, gated exactly as `tests/lib/usage/redis.test.ts` is:

```ts
import { test } from 'vitest'
import { createRedisHealthStore } from '@/lib/health/redis'
import { describeHealthStoreContract } from './store-contract'

const url = process.env.TEST_REDIS_URL

if (url) {
  describeHealthStoreContract('redis', () => createRedisHealthStore(url))
} else {
  test.skip('redis health driver contract (set TEST_REDIS_URL and run pnpm test:db:up)', () => {})
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/health/redis.test.ts`
Expected: FAIL — `Cannot find module '@/lib/health/redis'`.

- [ ] **Step 3: Write `src/lib/health/redis.ts`**

```ts
import { getRedisConnection } from '@/lib/redis/connection'
import { failKey, failTtlSeconds, metaKey, openKey, truncateError } from './keys'
import type { BreakerConfig, HealthStore, StoreStatus, TargetHealth } from './types'

export function createRedisHealthStore(url: string): HealthStore {
  const connection = getRedisConnection(url)
  const redis = connection.client

  return {
    name: 'redis',

    async openTargets(targetIds: string[]): Promise<Set<string>> {
      // MGET with no keys is a Redis error, and a model addressed directly has
      // no breakable targets at all — so this is a real case, not defensive.
      if (targetIds.length === 0) return new Set()
      await connection.ready()

      const values = await redis.mget(...targetIds.map(openKey))
      const open = new Set<string>()
      values.forEach((value, index) => {
        if (value !== null) open.add(targetIds[index])
      })
      return open
    },

    async details(targetIds: string[]): Promise<Map<string, TargetHealth>> {
      if (targetIds.length === 0) return new Map()
      await connection.ready()

      // Three commands per target in one round trip. This is the admin page's
      // read; the request path uses openTargets and never comes here.
      const pipeline = redis.pipeline()
      for (const id of targetIds) {
        pipeline.ttl(openKey(id))
        pipeline.get(failKey(id))
        pipeline.hgetall(metaKey(id))
      }
      const replies = await pipeline.exec()
      if (!replies) throw new Error('redis pipeline was aborted')

      const map = new Map<string, TargetHealth>()
      targetIds.forEach((id, index) => {
        const [ttlErr, ttlRaw] = replies[index * 3]
        const [failErr, failRaw] = replies[index * 3 + 1]
        const [metaErr, metaRaw] = replies[index * 3 + 2]
        if (ttlErr || failErr || metaErr) throw (ttlErr ?? failErr ?? metaErr)

        // TTL answers -2 for a missing key and -1 for one with no expiry.
        // Only a non-negative number means "open, with this long to run".
        const ttl = Number(ttlRaw)
        const failures = failRaw === null ? 0 : Number(failRaw)
        const meta = (metaRaw ?? {}) as Record<string, string>

        // Absence of every key is health, not an entry saying so.
        if (ttl < 0 && failures === 0) return

        map.set(id, {
          open: ttl >= 0,
          reopensIn: ttl >= 0 ? ttl : null,
          consecutiveFailures: failures,
          openedAt: meta.openedAt ? Number(meta.openedAt) : null,
          lastError: meta.lastError ?? null,
        })
      })
      return map
    },

    async fail(targetId: string, config: BreakerConfig, error: string): Promise<void> {
      if (config.threshold <= 0) return
      await connection.ready()

      const ttl = failTtlSeconds(config.cooldownSeconds)
      // MULTI, not a plain pipeline: it keeps the INCR and its EXPIRE from
      // being separated, so a crash cannot leave a counter with no expiry —
      // which would be a breaker that never forgets.
      const replies = await redis.multi().incr(failKey(targetId)).expire(failKey(targetId), ttl).exec()
      if (!replies) throw new Error('redis transaction was aborted')
      const [incrErr, incrRaw] = replies[0]
      if (incrErr) throw incrErr

      if (Number(incrRaw) < config.threshold) return

      // Crossing the threshold. Two instances can arrive here together; both
      // SET, the write is idempotent, and the second merely refreshes the TTL.
      // Locking would buy nothing.
      const now = Date.now()
      const opened = await redis
        .multi()
        .set(openKey(targetId), '1', 'EX', config.cooldownSeconds)
        .hset(metaKey(targetId), { openedAt: String(now), lastError: truncateError(error) })
        // The meta hash is only ever read alongside a live counter, so it
        // expires on the counter's schedule rather than growing forever.
        .expire(metaKey(targetId), ttl)
        .exec()
      if (!opened) throw new Error('redis transaction was aborted')
    },

    async succeed(targetId: string): Promise<void> {
      await connection.ready()
      await redis.del(openKey(targetId), failKey(targetId))
    },

    async reset(targetId: string): Promise<void> {
      await connection.ready()
      await redis.del(openKey(targetId), failKey(targetId), metaKey(targetId))
    },

    status(): StoreStatus {
      return connection.status()
    },

    async close(): Promise<void> {
      connection.close()
    },
  }
}
```

- [ ] **Step 4: Run the contract against Redis**

Run: `pnpm vitest run tests/lib/health/redis.test.ts`
Expected: PASS (11 tests). If they skip, the test Redis is not up — check `docker ps` for `babellm-test-redis-test-1` on 6380 and that `.env.test` has `TEST_REDIS_URL`. Do **not** run `pnpm test:db:down`.

- [ ] **Step 5: Commit**

```bash
pnpm test
git add src/lib/health/redis.ts tests/lib/health/redis.test.ts
git commit -m "feat(health): redis breaker driver"
```

---

### Task 5: The health store registry

**Files:**
- Create: `src/lib/health/registry.ts`, `src/lib/health/index.ts`
- Test: `tests/lib/health/registry.test.ts` (create)

**Interfaces:**
- Consumes: both drivers (Tasks 3–4).
- Produces:
  ```ts
  export function getHealthStore(): HealthStore
  export function resetHealthStore(): void
  export function healthStoreStatus(): { driver: string } & StoreStatus
  ```
  `src/lib/health/index.ts` re-exports the registry, `breaker.ts`, and `types.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/health/registry.test.ts`, mirroring `tests/lib/usage/registry.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { getHealthStore, healthStoreStatus, resetHealthStore } from '@/lib/health/registry'

afterEach(() => {
  delete process.env.REDIS_URL
  resetHealthStore()
})

test('without REDIS_URL the memory driver is used', () => {
  expect(getHealthStore().name).toBe('memory')
  expect(healthStoreStatus()).toEqual({ driver: 'memory', healthy: true, error: null })
})

test('the store is resolved once and reused', () => {
  expect(getHealthStore()).toBe(getHealthStore())
})

test('REDIS_URL selects the redis driver', () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1'
  expect(getHealthStore().name).toBe('redis')
})

test('a blank REDIS_URL is not a configured one', () => {
  process.env.REDIS_URL = '   '
  expect(getHealthStore().name).toBe('memory')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/health/registry.test.ts`
Expected: FAIL — `Cannot find module '@/lib/health/registry'`.

- [ ] **Step 3: Write `src/lib/health/registry.ts`**

```ts
import 'server-only'
import { createMemoryHealthStore } from './memory'
import { createRedisHealthStore } from './redis'
import type { HealthStore, StoreStatus } from './types'

let store: HealthStore | null = null

/**
 * The configured store, resolved once.
 *
 * `REDIS_URL` rather than a settings row, and the same variable the usage
 * counters read: this is infrastructure, like `DATABASE_URL`, and one Redis
 * URL for the gateway is one thing to get right rather than two.
 */
export function getHealthStore(): HealthStore {
  if (store) return store
  const url = process.env.REDIS_URL?.trim()
  store = url ? createRedisHealthStore(url) : createMemoryHealthStore()
  return store
}

/** Tests only. Drops the resolved store and any connection it holds. */
export function resetHealthStore(): void {
  void store?.close?.().catch((err) => {
    console.error('[gateway] failed to close the target health store', err)
  })
  store = null
}

export function healthStoreStatus(): { driver: string } & StoreStatus {
  const resolved = getHealthStore()
  return { driver: resolved.name, ...resolved.status() }
}
```

- [ ] **Step 4: Write `src/lib/health/index.ts`**

```ts
export { breakerState, resolveBreakerConfig, DEFAULT_COOLDOWN_SECONDS, DEFAULT_THRESHOLD } from './breaker'
export { getHealthStore, healthStoreStatus, resetHealthStore } from './registry'
export type { BreakerConfig, BreakerState, HealthStore, StoreStatus, TargetHealth } from './types'
export { CLOSED } from './types'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/health/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
pnpm test
git add src/lib/health/registry.ts src/lib/health/index.ts tests/lib/health/registry.test.ts
git commit -m "feat(health): resolve the breaker store from REDIS_URL"
```

---

### Task 6: Per-target override columns and global routing settings

**Files:**
- Modify: `src/lib/db/schema.ts:67-83` (`routeTargets`), `src/lib/settings.ts` (append)
- Create: `drizzle/0007_*.sql` (generated), `src/lib/routing-settings.ts`
- Test: `tests/lib/db/schema.test.ts` (extend), `tests/lib/routing-settings.test.ts` (create)

**Interfaces:**
- Consumes: `BreakerConfig`, `DEFAULT_THRESHOLD`, `DEFAULT_COOLDOWN_SECONDS` (Task 2).
- Produces:
  ```ts
  // schema.ts — new columns on routeTargets
  breakerThreshold: number | null
  breakerCooldownSeconds: number | null

  // settings.ts
  export async function getRoutingSettings(): Promise<BreakerConfig>
  export async function setRoutingSettings(patch: Partial<BreakerConfig>): Promise<BreakerConfig>

  // routing-settings.ts
  export const ROUTING_SETTINGS_TTL_MS = 10_000
  export async function resolveRoutingSettings(): Promise<BreakerConfig>
  export function clearRoutingSettingsCache(): void
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/db/schema.test.ts`. That file seeds inline with `db.insert(...).returning()` and imports `encryptJson`, `eq`, and the tables it needs — all already present at the top:

```ts
test('route targets carry nullable breaker overrides', async () => {
  const [p] = await db.insert(providers).values({
    name: 'breaker-p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'breaker-model' }).returning()
  const [row] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'm-1',
  }).returning()

  // NULL is the inherit signal, so the columns must have no default.
  expect(row.breakerThreshold).toBeNull()
  expect(row.breakerCooldownSeconds).toBeNull()

  await db.update(routeTargets)
    .set({ breakerThreshold: 0, breakerCooldownSeconds: 5 })
    .where(eq(routeTargets.id, row.id))
  const [updated] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))

  // 0 is a real value — "never open this target" — not an absent one.
  expect(updated.breakerThreshold).toBe(0)
  expect(updated.breakerCooldownSeconds).toBe(5)
})
```

Create `tests/lib/routing-settings.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { getRoutingSettings, setRoutingSettings } from '@/lib/settings'
import { clearRoutingSettingsCache, resolveRoutingSettings } from '@/lib/routing-settings'
import { resetDb } from '../helpers/db'

beforeEach(async () => {
  await resetDb()
  clearRoutingSettingsCache()
})

afterEach(() => {
  clearRoutingSettingsCache()
})

test('an empty settings table yields the spec defaults', async () => {
  expect(await getRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })
})

test('each field can be saved on its own', async () => {
  expect(await setRoutingSettings({ threshold: 2 }))
    .toEqual({ threshold: 2, cooldownSeconds: 30 })
  expect(await setRoutingSettings({ cooldownSeconds: 90 }))
    .toEqual({ threshold: 2, cooldownSeconds: 90 })
})

test('a threshold of 0 is accepted — it disables the breaker', async () => {
  expect(await setRoutingSettings({ threshold: 0 })).toEqual({ threshold: 0, cooldownSeconds: 30 })
})

test('nonsense is rejected rather than stored', async () => {
  await expect(setRoutingSettings({ threshold: -1 })).rejects.toThrow(/threshold/i)
  await expect(setRoutingSettings({ threshold: 1.5 })).rejects.toThrow(/threshold/i)
  await expect(setRoutingSettings({ cooldownSeconds: 0 })).rejects.toThrow(/cooldown/i)
})

test('the cache serves repeat reads and a clear picks up a write', async () => {
  expect(await resolveRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })
  await setRoutingSettings({ threshold: 3 })
  // Still cached — other instances converge within the TTL, which is the
  // documented trade for keeping settings off the failure path.
  expect(await resolveRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })

  clearRoutingSettingsCache()
  expect(await resolveRoutingSettings()).toEqual({ threshold: 3, cooldownSeconds: 30 })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/lib/routing-settings.test.ts tests/lib/db/schema.test.ts`
Expected: FAIL — `Cannot find module '@/lib/routing-settings'`, and `breakerThreshold` not on the row type.

- [ ] **Step 3: Add the columns to the schema**

In `src/lib/db/schema.ts`, inside `routeTargets` immediately after `serviceTier`:

```ts
  // Nullable with no default: NULL means "inherit the global", and 0 is a
  // distinct, meaningful value — "never open this target" — so a default
  // would make the two indistinguishable.
  breakerThreshold: integer('breaker_threshold'),
  breakerCooldownSeconds: integer('breaker_cooldown_seconds'),
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
pnpm db:generate
```

Expected: a new `drizzle/0007_<name>.sql` containing exactly two `ALTER TABLE "route_targets" ADD COLUMN` statements. Read it before continuing — if it contains anything else (a DROP, a table rebuild), stop and report, because that means the schema file drifted from the database.

- [ ] **Step 5: Add the settings accessors**

Append to `src/lib/settings.ts`, following the shape of `getLoggingSettings` / `setLoggingSettings` already in the file:

```ts
export const DEFAULT_BREAKER_THRESHOLD = 5
export const DEFAULT_BREAKER_COOLDOWN_SECONDS = 30

const ROUTING_KEYS = {
  breakerThreshold: 'routing.breaker_threshold',
  breakerCooldownSeconds: 'routing.breaker_cooldown_seconds',
} as const

export async function getRoutingSettings(): Promise<BreakerConfig> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const threshold = byKey.get(ROUTING_KEYS.breakerThreshold)
  const cooldown = byKey.get(ROUTING_KEYS.breakerCooldownSeconds)

  return {
    threshold: typeof threshold === 'number' ? threshold : DEFAULT_BREAKER_THRESHOLD,
    cooldownSeconds:
      typeof cooldown === 'number' ? cooldown : DEFAULT_BREAKER_COOLDOWN_SECONDS,
  }
}

export async function setRoutingSettings(
  patch: Partial<BreakerConfig>,
): Promise<BreakerConfig> {
  const writes: Array<[string, unknown]> = []

  if (patch.threshold !== undefined) {
    // 0 is legal and means "never open a breaker"; a negative or fractional
    // count is not a number of failures at all.
    if (!Number.isInteger(patch.threshold) || patch.threshold < 0) {
      throw new Error('The breaker threshold must be a whole number of failures, 0 or more.')
    }
    writes.push([ROUTING_KEYS.breakerThreshold, patch.threshold])
  }
  if (patch.cooldownSeconds !== undefined) {
    if (!Number.isInteger(patch.cooldownSeconds) || patch.cooldownSeconds < 1) {
      throw new Error('The breaker cooldown must be a whole number of seconds, 1 or more.')
    }
    writes.push([ROUTING_KEYS.breakerCooldownSeconds, patch.cooldownSeconds])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }

  return getRoutingSettings()
}
```

Add `import type { BreakerConfig } from '@/lib/health/types'` at the top of the file.

- [ ] **Step 6: Write `src/lib/routing-settings.ts`**

This mirrors `src/lib/logs/registry.ts`, including the inflight/generation guard — the comments there explain why each piece exists, and the same reasoning applies verbatim:

```ts
import 'server-only'
import type { BreakerConfig } from '@/lib/health/types'
import {
  DEFAULT_BREAKER_COOLDOWN_SECONDS, DEFAULT_BREAKER_THRESHOLD, getRoutingSettings,
} from '@/lib/settings'

/**
 * How long resolved breaker settings are trusted.
 *
 * The failure path reads these on every failed attempt, and a provider outage
 * is exactly when failures are most frequent — so an uncached read would turn
 * an upstream outage into a burst of queries against the database that also
 * serves the dashboard. The cost is that a threshold change takes up to this
 * long to reach other instances, which the Settings page states plainly.
 */
export const ROUTING_SETTINGS_TTL_MS = 10_000

const FALLBACK: BreakerConfig = {
  threshold: DEFAULT_BREAKER_THRESHOLD,
  cooldownSeconds: DEFAULT_BREAKER_COOLDOWN_SECONDS,
}

let cached: { at: number; config: BreakerConfig } | null = null
let inflight: Promise<BreakerConfig> | null = null
let generation = 0

export function clearRoutingSettingsCache(): void {
  cached = null
  inflight = null
  // Any resolution still in flight was started against settings that have
  // since changed. Bumping the generation makes it return its value to its
  // own callers without publishing it to the cache.
  generation += 1
}

export async function resolveRoutingSettings(): Promise<BreakerConfig> {
  if (cached && Date.now() - cached.at < ROUTING_SETTINGS_TTL_MS) return cached.config

  // Concurrent callers share one resolution. Without this, every failed
  // attempt during a miss window issues its own query — and when the database
  // is the thing that is struggling, that is the worst possible moment.
  const startedAt = generation
  inflight ??= read()
    .then((config) => {
      if (startedAt === generation) cached = { at: Date.now(), config }
      return config
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function read(): Promise<BreakerConfig> {
  try {
    return await getRoutingSettings()
  } catch (err) {
    // Refusing to serve requests because a *breaker tuning* value could not be
    // read would be the wrong hierarchy of concerns.
    console.error('[gateway] could not read routing settings; using defaults', err)
    return FALLBACK
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/routing-settings.test.ts tests/lib/db/schema.test.ts`
Expected: PASS. The migration is applied automatically by `tests/setup/global-setup.ts`.

- [ ] **Step 8: Commit**

```bash
pnpm test
git add src/lib/db/schema.ts src/lib/settings.ts src/lib/routing-settings.ts drizzle tests/lib/routing-settings.test.ts tests/lib/db/schema.test.ts
git commit -m "feat(routing): breaker threshold and cooldown, global and per target"
```

---

### Task 7: Mark which candidates can break

**Files:**
- Modify: `src/lib/gateway/resolve.ts:12-24` (`Candidate`), `:96-103` (`findVirtualModel`), `:146-155` (`resolveDirect`)
- Test: `tests/lib/gateway/resolve.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: three new fields on `Candidate`:
  ```ts
  /** Whether an open breaker may demote this candidate. False for a direct
   *  `provider/model` address, which has no route_targets row behind it. */
  breakable: boolean
  breakerThreshold: number | null
  breakerCooldownSeconds: number | null
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/gateway/resolve.test.ts`. It has a `seed()` helper returning `{ fast, slow, model }` and inserts route targets explicitly; the direct-address tests in that file insert into `catalogModels`:

```ts
test('virtual model targets are breakable and carry their overrides', async () => {
  const { fast, model } = await seed()
  await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: fast.id,
    upstreamModel: 'fast-1',
    breakerThreshold: 2,
    // Left null on purpose: overrides apply per field, so this target pins a
    // threshold and still inherits the global cooldown.
    breakerCooldownSeconds: null,
  })

  const { candidates } = await resolveModel('house-model')

  expect(candidates[0].breakable).toBe(true)
  expect(candidates[0].breakerThreshold).toBe(2)
  expect(candidates[0].breakerCooldownSeconds).toBeNull()
})

test('a direct provider/model address is never breakable', async () => {
  // It is a single-candidate chain, so an open breaker could only turn a
  // request that might have succeeded into a guaranteed 503.
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'gpt-5' })

  const { candidates } = await resolveModel('fast-provider/gpt-5')

  expect(candidates).toHaveLength(1)
  expect(candidates[0].breakable).toBe(false)
  expect(candidates[0].breakerThreshold).toBeNull()
  expect(candidates[0].breakerCooldownSeconds).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/gateway/resolve.test.ts`
Expected: FAIL — `breakable` does not exist on type `Candidate`.

- [ ] **Step 3: Extend the `Candidate` interface**

In `src/lib/gateway/resolve.ts`, add to `Candidate` after `serviceTier`:

```ts
  /**
   * Whether an open breaker may demote this candidate.
   *
   * False for a direct `provider/model` address: `targetId` there is a
   * catalog_models id, the chain has exactly one link, and demoting the only
   * link could only convert a request that might have succeeded into a
   * guaranteed failure.
   */
  breakable: boolean
  /** Per-target breaker overrides. NULL inherits the global setting. */
  breakerThreshold: number | null
  breakerCooldownSeconds: number | null
```

- [ ] **Step 4: Populate them at both call sites**

In `findVirtualModel`, extend the candidate mapping:

```ts
    candidates: rows.map(({ target, provider }) => ({
      targetId: target.id,
      provider,
      upstreamModel: target.upstreamModel,
      priority: target.priority,
      weight: target.weight,
      serviceTier: target.serviceTier,
      breakable: true,
      breakerThreshold: target.breakerThreshold,
      breakerCooldownSeconds: target.breakerCooldownSeconds,
    })),
```

In `resolveDirect`, extend the single candidate:

```ts
      serviceTier: null,
      // No route_targets row stands behind a direct address, so there is
      // nothing to break and nothing that could have configured a breaker.
      breakable: false,
      breakerThreshold: null,
      breakerCooldownSeconds: null,
```

- [ ] **Step 5: Fix every other construction of a `Candidate`**

Run: `pnpm typecheck`
Expected: errors in test helpers that build `Candidate` literals. Add `breakable: true, breakerThreshold: null, breakerCooldownSeconds: null` to each, except where the test is specifically about direct addressing. Re-run until clean.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/gateway/resolve.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm test
git add src/lib/gateway/resolve.ts tests
git commit -m "feat(routing): mark which candidates a breaker may demote"
```

---

### Task 8: Partition the attempt chain by health

The ordering change itself, entirely as pure data — no store, no async.

**Files:**
- Modify: `src/lib/gateway/select.ts:4-7` (`SelectDeps`), `:36-47` (the zero-weight comment), `:103-126` (`selectOrder`)
- Test: `tests/lib/gateway/select.test.ts` (extend)

**Interfaces:**
- Consumes: `Candidate.breakable` (Task 7).
- Produces: `SelectDeps.open: ReadonlySet<string>`, defaulting to an empty set.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/gateway/select.test.ts`. Reuse the file's existing factories exactly as they are: `candidate(name, weight = 100, priority = 0)` is **positional**, it builds `targetId` as `` `target-${name}` ``, and the file's `names(chain)` helper maps to `provider.name`. Add one local helper for readability:

```ts
/** The ids `candidate()` generates, so a test names targets the way it reads. */
const openSet = (...names: string[]) => new Set(names.map((n) => `target-${n}`))

test('an open target sinks behind a healthy one in the same tier', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b')],
    model({ maxAttempts: 5 }),
    { open: openSet('a') },
  )
  expect(names(chain)).toEqual(['b', 'a'])
})

test('an open target sinks past a later tier', () => {
  // A weight of 0 stays inside its tier; an open breaker does not. A weight is
  // a configured preference, an open breaker is an observed fact.
  const chain = selectOrder(
    [candidate('a', 100, 0), candidate('b', 100, 1)],
    model({ maxAttempts: 5 }),
    { open: openSet('a') },
  )
  expect(names(chain)).toEqual(['b', 'a'])
})

test('with every target open the chain is the full list in policy order', () => {
  const chain = selectOrder(
    [candidate('a', 100, 0), candidate('b', 100, 1)],
    model({ maxAttempts: 5 }),
    { open: openSet('a', 'b') },
  )
  // Demotion, never exclusion: a total outage must not become a 503 where
  // today it would have been an attempt.
  expect(names(chain)).toEqual(['a', 'b'])
})

test('max_attempts spends its budget on healthy targets first', () => {
  const chain = selectOrder(
    [candidate('a', 100, 0), candidate('b', 100, 0), candidate('c', 100, 1)],
    model({ maxAttempts: 2 }),
    { open: openSet('a', 'b') },
  )
  expect(names(chain)).toEqual(['c', 'a'])
})

test('an unbreakable candidate is never treated as open', () => {
  const direct = { ...candidate('a'), breakable: false }
  const chain = selectOrder([direct], model({ maxAttempts: 1 }), { open: openSet('a') })
  expect(names(chain)).toEqual(['a'])
})

test('no health information is the same as nothing being open', () => {
  const chain = selectOrder([candidate('a'), candidate('b')], model({ maxAttempts: 5 }))
  expect(names(chain)).toEqual(['a', 'b'])
})

test('weighted ordering still applies within each partition', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'weighted', maxAttempts: 5 }),
    { open: openSet('a'), random: () => 0 },
  )
  // 'a' is last however the draw falls; the healthy two are drawn among
  // themselves.
  expect(names(chain).at(-1)).toBe('a')
  expect(names(chain).slice(0, 2).sort()).toEqual(['b', 'c'])
})

test('round robin still rotates within the healthy partition', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'round_robin', maxAttempts: 5 }),
    { open: openSet('c'), nextCursor: () => 1 },
  )
  // The healthy pair [a, b] rotates by one; the open target follows behind.
  expect(names(chain)).toEqual(['b', 'a', 'c'])
})
```

Also add `breakable: true, breakerThreshold: null, breakerCooldownSeconds: null` to the `candidate()` factory at the top of the file, or it will not typecheck once Task 7 has landed.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/lib/gateway/select.test.ts`
Expected: FAIL — `open` is not a property of `SelectDeps`.

- [ ] **Step 3: Extend `SelectDeps`**

```ts
export interface SelectDeps {
  random: () => number
  nextCursor: (virtualModelId: string) => number
  /**
   * Target ids whose breaker is currently open.
   *
   * Empty when health is unavailable, which is deliberate: "we could not read
   * health" and "nothing is open" are the same value, so failing open is a
   * property of the type rather than a branch someone can forget.
   */
  open: ReadonlySet<string>
}
```

- [ ] **Step 4: Rewrite `selectOrder`**

Replace the body from `const { random = ... }` to the end:

```ts
  const {
    random = Math.random,
    nextCursor = defaultNextCursor,
    open = new Set<string>(),
  } = deps
  // Read once per request rather than once per tier: advancing the cursor per
  // tier would make how fast a model cycles depend on how it happens to be
  // tiered, and skip positions in the tiers that are shorter.
  const cursor = model.policy === 'round_robin' ? nextCursor(model.id) : 0

  const arrange = (subset: Candidate[]) =>
    tiersOf(subset).flatMap((tier) =>
      model.policy === 'weighted' ? weightedOrder(tier, random)
      : model.policy === 'round_robin' ? rotate(tier, cursor)
      : tier,
    )

  // Partition before tiering, so an open breaker sinks past *later tiers* and
  // not merely to the back of its own. See the note above weightedOrder for
  // why this is the opposite of what a zero weight does.
  //
  // Demotion, never exclusion: with every target open the healthy partition is
  // empty and the chain is simply the full candidate list in policy order — so
  // a total outage degrades to today's behaviour instead of to a 503.
  const isOpen = (candidate: Candidate) => candidate.breakable && open.has(candidate.targetId)
  const ordered = [
    ...arrange(candidates.filter((candidate) => !isOpen(candidate))),
    ...arrange(candidates.filter(isOpen)),
  ]

  // max_attempts is a bare integer column, so a 0 or a negative is storable.
  // One attempt is the smallest number that still asks a provider anything.
  // It caps the flattened chain, so a fat first tier can starve a later one.
  return ordered.slice(0, Math.max(1, model.maxAttempts))
```

- [ ] **Step 5: Rewrite the zero-weight comment so the two rules read as deliberate**

Replace the final paragraph of the doc comment above `weightedOrder` (the one beginning "Non-positive weights are appended…") with:

```
 * Non-positive weights are appended at the end of their own tier rather than
 * dropped: a weight of 0 reads as "prefer never", and dropping it would leave
 * a model whose targets are all zero with nothing to try. They stay inside the
 * tier because sinking them past a later one would invert the order priority
 * exists to express.
 *
 * An open breaker does sink past later tiers, and the difference is the source
 * of the signal. A weight of 0 is a configured preference, so honouring
 * priority above it respects what the operator asked for. An open breaker is
 * an observed fact — evidence this target is failing right now. Demoting a
 * target you have evidence is broken below one you have no such evidence about
 * is not overriding the operator's intent, it is serving it.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/gateway/select.test.ts`
Expected: PASS — the new tests plus every pre-existing one, unchanged, because `open` defaults to empty.

- [ ] **Step 7: Commit**

```bash
pnpm test
git add src/lib/gateway/select.ts tests/lib/gateway/select.test.ts
git commit -m "feat(routing): demote targets with an open breaker in the attempt chain"
```

---

### Task 9: Record attempt outcomes from the execute loop

**Files:**
- Modify: `src/lib/gateway/execute.ts:31-33` (`ExecuteDeps`), `:115-156` (the loop)
- Test: `tests/lib/gateway/execute.test.ts` (extend)

**Interfaces:**
- Consumes: `Candidate.breakable` (Task 7).
- Produces:
  ```ts
  export interface ExecuteDeps {
    createAdapter: (provider: ProviderRow) => ProviderAdapter
    recordHealth?: (candidate: Candidate, outcome: 'success' | 'failure', error?: string) => void
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/gateway/execute.test.ts`. That file already defines `candidate(name)` (whose `targetId` is `` `target-${name}` ``), a `stubAdapter`, a shared `deps = { createAdapter: () => stubAdapter }`, and `live` for a non-aborted signal:

```ts
/** Collects (targetId, outcome) pairs so a test can assert on the whole set
 *  of calls, including the ones that must not happen. */
function recorder() {
  const calls: Array<[string, string]> = []
  return {
    calls,
    recordHealth: (c: Candidate, outcome: 'success' | 'failure') => {
      calls.push([c.targetId, outcome])
    },
  }
}

test('a successful attempt is recorded as a success', async () => {
  const { calls, recordHealth } = recorder()
  await execute([candidate('a')], 'req_1', live, { ...deps, recordHealth }, async () => 'body')

  expect(calls).toEqual([['target-a', 'success']])
})

test('a retryable failure is recorded against the target that produced it', async () => {
  const { calls, recordHealth } = recorder()
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 503, message: 'down', retryable: true }))
    .mockResolvedValueOnce('body')

  await execute([candidate('a'), candidate('b')], 'req_1', live, { ...deps, recordHealth }, run)

  expect(calls).toEqual([['target-a', 'failure'], ['target-b', 'success']])
})

test('a client hanging up is not held against the target', async () => {
  // An AbortError classifies as a retryable 504. Counting it would open
  // breakers on healthy targets serving slow, cancellable generations.
  const { calls, recordHealth } = recorder()
  const controller = new AbortController()
  controller.abort()
  const run = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))

  await expect(
    execute([candidate('a')], 'req_1', controller.signal, { ...deps, recordHealth }, run),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('a non-retryable 4xx is recorded in neither direction', async () => {
  // The target answered, so it is not a failure; but clearing the counter
  // would let one bad client erase real accumulated evidence.
  const { calls, recordHealth } = recorder()
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 400, message: 'bad', retryable: false }),
  )

  await expect(
    execute([candidate('a')], 'req_1', live, { ...deps, recordHealth }, run),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('an unconstructable adapter is not recorded', async () => {
  // No upstream call was made, so there is nothing to protect.
  const { calls, recordHealth } = recorder()
  const createAdapter = () => { throw new UnsupportedOperationError('no adapter') }

  await expect(
    execute([candidate('a')], 'req_1', live, { createAdapter, recordHealth }, async () => 'body'),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('an unbreakable candidate is never recorded', async () => {
  const { calls, recordHealth } = recorder()
  const direct = { ...candidate('a'), breakable: false }

  await execute([direct], 'req_1', live, { ...deps, recordHealth }, async () => 'body')

  expect(calls).toEqual([])
})
```

Also add `breakable: true, breakerThreshold: null, breakerCooldownSeconds: null` to this file's `candidate()` factory.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/lib/gateway/execute.test.ts`
Expected: FAIL — `recordHealth` is not a property of `ExecuteDeps`.

- [ ] **Step 3: Extend `ExecuteDeps`**

```ts
export interface ExecuteDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
  /**
   * Reports an attempt's outcome to the circuit breaker.
   *
   * Synchronous and must never throw: the implementation is fire-and-forget,
   * like emitRequestLog. Health bookkeeping may not add latency to a response
   * or fail a request that has already succeeded.
   */
  recordHealth?: (
    candidate: Candidate,
    outcome: 'success' | 'failure',
    error?: string,
  ) => void
}
```

- [ ] **Step 4: Call it from the loop**

`execute.ts` already has a module-level `record(index, candidate, latencyMs, classified)` that builds an `AttemptRecord`. Name the new helper `recordHealth` so it does not shadow it. Add it inside `execute`, above the `for` loop:

```ts
  const recordHealth = (
    candidate: Candidate,
    outcome: 'success' | 'failure',
    error?: string,
  ) => {
    // A direct provider/model address has no route_targets row behind it and
    // is never demoted, so there is nothing to learn about it.
    if (candidate.breakable) deps.recordHealth?.(candidate, outcome, error)
  }
```

In the success branch, immediately after the existing `attempts.push(...)`:

```ts
      const value = await run(...)
      attempts.push(record(index, candidate, Date.now() - startedAt))
      recordHealth(candidate, 'success')
      return { value, candidate, attempts }
```

In the failure branch, after `last = routed(...)`:

```ts
      // Only a retryable failure is evidence about the target. A 4xx means it
      // answered, and an aborted client produces a retryable 504 that says
      // nothing about the provider at all.
      if (classified.retryable && !clientSignal.aborted) {
        recordHealth(candidate, 'failure', classified.message)
      }
```

The `createAdapter` catch block gets no call at all.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/gateway/execute.test.ts`
Expected: PASS — the new tests plus every pre-existing one, since `recordHealth` is optional.

- [ ] **Step 6: Commit**

```bash
pnpm test
git add src/lib/gateway/execute.ts tests/lib/gateway/execute.test.ts
git commit -m "feat(routing): report attempt outcomes to the circuit breaker"
```

---

### Task 10: Wire the breaker into the request path

**Files:**
- Create: `src/lib/gateway/health.ts`
- Modify: `src/lib/gateway/chat-handler.ts:294-295` (selection), and wherever `ChatHandlerDeps` is spread into `execute`
- Test: `tests/gateway/breaker.test.ts` (create)

**Interfaces:**
- Consumes: `getHealthStore` (Task 5), `resolveRoutingSettings` (Task 6), `resolveBreakerConfig` (Task 2), `Candidate` (Task 7).
- Produces:
  ```ts
  export async function openTargetsFor(candidates: Candidate[]): Promise<ReadonlySet<string>>
  export function recordHealth(candidate: Candidate, outcome: 'success' | 'failure', error?: string): void
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/breaker.test.ts`, using the same machinery `tests/gateway/failover.test.ts` uses — `seedTargets({ targets: [...] })`, `chatRequest(body, apiKey)`, `fakeAdapterByProvider({ name: { chat } })`, and calling `handleChatCompletions` directly. No new helper is needed.

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { clearRoutingSettingsCache } from '@/lib/routing-settings'
import { setRoutingSettings } from '@/lib/settings'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

const apiError = (status: number, message = 'boom') =>
  new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  resetHealthStore()
  clearRoutingSettingsCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  resetHealthStore()
  clearRoutingSettingsCache()
})

test('a target that keeps failing stops being attempted', async () => {
  await setRoutingSettings({ threshold: 2, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const primary = vi.fn().mockRejectedValue(apiError(503, 'down'))
  const backup = vi.fn().mockResolvedValue(completion('backup'))
  const deps = fakeAdapterByProvider({
    primary: { chat: primary },
    backup: { chat: backup },
  })

  // Two failures open the breaker. Both requests still succeed via failover.
  for (let i = 0; i < 2; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
  }
  expect(primary).toHaveBeenCalledTimes(2)

  // recordHealth is fire-and-forget, so let the queued writes settle before
  // asserting on what the next request sees.
  await new Promise((resolve) => setImmediate(resolve))

  for (let i = 0; i < 2; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
  }

  // The whole point of the feature: the broken target is not called again.
  expect(primary).toHaveBeenCalledTimes(2)
  expect(backup).toHaveBeenCalledTimes(4)
})

test('a request is still attempted when every target has an open breaker', async () => {
  await setRoutingSettings({ threshold: 1, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const failing = fakeAdapterByProvider({
    primary: { chat: vi.fn().mockRejectedValue(apiError(503)) },
    backup: { chat: vi.fn().mockRejectedValue(apiError(503)) },
  })
  await handleChatCompletions(chatRequest(body, apiKey), failing)
  await new Promise((resolve) => setImmediate(resolve))

  // Both breakers are open and the providers have recovered. Demotion rather
  // than exclusion means the request is still attempted, and still succeeds.
  const recovered = fakeAdapterByProvider({
    primary: { chat: vi.fn().mockResolvedValue(completion('primary')) },
    backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
  })
  expect((await handleChatCompletions(chatRequest(body, apiKey), recovered)).status).toBe(200)
})

test('routing is unchanged when the health store is unusable', async () => {
  // Fail-open is the contract: a Redis outage degrades routing to its
  // pre-breaker behaviour, never to something worse.
  await setRoutingSettings({ threshold: 1, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const store = getHealthStore()
  const boom = () => Promise.reject(new Error('redis is gone'))
  store.openTargets = boom
  store.fail = boom
  store.succeed = boom
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const primary = vi.fn().mockRejectedValue(apiError(503, 'down'))
  const deps = fakeAdapterByProvider({
    primary: { chat: primary },
    backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
  })

  for (let i = 0; i < 3; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
    await new Promise((resolve) => setImmediate(resolve))
  }

  // Never skipped, never crashed — exactly what happened before the breaker.
  expect(primary).toHaveBeenCalledTimes(3)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/gateway/breaker.test.ts`
Expected: FAIL — the down provider is still called on every request.

- [ ] **Step 3: Write `src/lib/gateway/health.ts`**

```ts
import 'server-only'
import { getHealthStore, resolveBreakerConfig } from '@/lib/health'
import { resolveRoutingSettings } from '@/lib/routing-settings'
import type { Candidate } from './resolve'

/**
 * Which of these candidates currently have an open breaker.
 *
 * Never throws. A health store that is unreachable yields an empty set, which
 * `selectOrder` reads as "nothing is open" — so routing degrades to exactly
 * its pre-breaker behaviour rather than to something worse.
 */
export async function openTargetsFor(
  candidates: Candidate[],
): Promise<ReadonlySet<string>> {
  const ids = candidates.filter((candidate) => candidate.breakable).map((c) => c.targetId)
  if (ids.length === 0) return new Set()

  try {
    return await getHealthStore().openTargets(ids)
  } catch (err) {
    console.error('[gateway] could not read target health; routing without it', err)
    return new Set()
  }
}

/**
 * Reports an attempt's outcome, fire-and-forget.
 *
 * Synchronous by signature and asynchronous underneath, deliberately: this is
 * called from the attempt loop, and awaiting it would put a Redis round trip
 * — and a Redis outage — on the path of a response that has already been
 * decided.
 */
export function recordHealth(
  candidate: Candidate,
  outcome: 'success' | 'failure',
  error?: string,
): void {
  void (async () => {
    const store = getHealthStore()
    if (outcome === 'success') {
      await store.succeed(candidate.targetId)
      return
    }
    // Only the failure path needs configuration, which is why no settings read
    // sits on the request-critical path at all.
    const globals = await resolveRoutingSettings()
    await store.fail(candidate.targetId, resolveBreakerConfig(candidate, globals), error ?? '')
  })().catch((err) => {
    console.error(`[gateway] failed to record target health target_id=${candidate.targetId}`, err)
  })
}
```

- [ ] **Step 4: Wire it into `chat-handler.ts`**

Add the import:

```ts
import { openTargetsFor, recordHealth } from './health'
```

Replace lines 294–295:

```ts
    const { model, candidates } = await resolveModel(body.model)
    const open = await openTargetsFor(candidates)
    const chain = selectOrder(candidates, model, { open })
```

Both `execute(...)` call sites already pass `deps`. Extend the deps object handed to them so `recordHealth` travels with it — at each `execute(chain, requestId, request.signal, deps, ...)`, change `deps` to `{ ...deps, recordHealth }`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/gateway/breaker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
pnpm test
git add src/lib/gateway/health.ts src/lib/gateway/chat-handler.ts tests/gateway/breaker.test.ts tests/helpers/gateway.ts
git commit -m "feat(gateway): route around targets with an open breaker"
```

---

### Task 11: Show breaker state and offer a manual reset

**Files:**
- Create: `src/lib/admin/health.ts`
- Modify: `src/lib/admin/models.ts:32-50` (`VirtualModelListItem` target shape), `:88-101` (`getVirtualModel`), `src/app/(admin)/models/[id]/page.tsx` (target table), `src/app/(admin)/models/target-row-actions.tsx`, `src/app/(admin)/models/actions.ts`
- Test: `tests/lib/admin/health.test.ts` (create)

**Interfaces:**
- Consumes: `getHealthStore`, `breakerState`, `resolveBreakerConfig` (Tasks 2/5); `resolveRoutingSettings` (Task 6).
- Produces:
  ```ts
  export interface TargetBreakerView {
    state: BreakerState
    reopensIn: number | null
    lastError: string | null
  }
  export async function targetBreakerViews(
    targets: Array<{ id: string; breakerThreshold: number | null; breakerCooldownSeconds: number | null }>,
  ): Promise<Map<string, TargetBreakerView>>
  export async function resetTargetBreakerAction(formData: FormData): Promise<void>
  ```
  `VirtualModelListItem`'s target objects gain `breakerThreshold: number | null` and `breakerCooldownSeconds: number | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/admin/health.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { targetBreakerViews } from '@/lib/admin/health'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { clearRoutingSettingsCache } from '@/lib/routing-settings'
import { resetDb } from '../../helpers/db'

const target = (id: string, threshold: number | null = null) => ({
  id, breakerThreshold: threshold, breakerCooldownSeconds: null,
})

beforeEach(async () => {
  await resetDb()
  resetHealthStore()
  clearRoutingSettingsCache()
})

afterEach(() => {
  resetHealthStore()
  clearRoutingSettingsCache()
})

test('a target with no history reads closed', async () => {
  const views = await targetBreakerViews([target('a')])
  expect(views.get('a')).toEqual({ state: 'closed', reopensIn: null, lastError: null })
})

test('an open breaker reports how long it has left and why', async () => {
  const store = getHealthStore()
  const config = { threshold: 1, cooldownSeconds: 30 }
  await store.fail('a', config, 'upstream exploded')

  const views = await targetBreakerViews([target('a', 1)])
  expect(views.get('a')?.state).toBe('open')
  expect(views.get('a')?.reopensIn).toBeGreaterThan(0)
  expect(views.get('a')?.lastError).toBe('upstream exploded')
})

test('a per-target threshold decides the reading', async () => {
  const store = getHealthStore()
  await store.fail('a', { threshold: 10, cooldownSeconds: 30 }, 'boom')

  // One failure against a threshold of 10: nowhere near open.
  expect((await targetBreakerViews([target('a', 10)])).get('a')?.state).toBe('closed')
})

test('an unreadable store reports every target as closed', async () => {
  const store = getHealthStore()
  store.details = () => Promise.reject(new Error('redis is gone'))

  const views = await targetBreakerViews([target('a')])
  expect(views.get('a')).toEqual({ state: 'closed', reopensIn: null, lastError: null })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/admin/health.test.ts`
Expected: FAIL — `Cannot find module '@/lib/admin/health'`.

- [ ] **Step 3: Write `src/lib/admin/health.ts`**

```ts
import 'server-only'
import { CLOSED, breakerState, getHealthStore, resolveBreakerConfig, type BreakerState } from '@/lib/health'
import { resolveRoutingSettings } from '@/lib/routing-settings'

export interface TargetBreakerView {
  state: BreakerState
  /** Seconds until the breaker reopens. null unless open. */
  reopensIn: number | null
  lastError: string | null
}

const CLOSED_VIEW: TargetBreakerView = { state: 'closed', reopensIn: null, lastError: null }

/**
 * The badge data for a page's worth of targets, in one store round trip.
 *
 * Reading health must never take the admin page down — an unreachable Redis
 * makes the column read "closed" rather than throwing a 500 at an operator who
 * is probably here *because* something is wrong.
 */
export async function targetBreakerViews(
  targets: Array<{
    id: string
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
  }>,
): Promise<Map<string, TargetBreakerView>> {
  const views = new Map<string, TargetBreakerView>()
  if (targets.length === 0) return views

  let globals
  let details
  try {
    ;[globals, details] = await Promise.all([
      resolveRoutingSettings(),
      getHealthStore().details(targets.map((target) => target.id)),
    ])
  } catch (err) {
    console.error('[gateway] could not read target health for the dashboard', err)
    for (const target of targets) views.set(target.id, CLOSED_VIEW)
    return views
  }

  for (const target of targets) {
    const health = details.get(target.id) ?? CLOSED
    const config = resolveBreakerConfig(target, globals)
    views.set(target.id, {
      state: breakerState(health, config),
      reopensIn: health.reopensIn,
      lastError: health.lastError,
    })
  }
  return views
}
```

- [ ] **Step 4: Carry the override columns through the admin model type**

In `src/lib/admin/models.ts`, add the two fields to the target object inside `VirtualModelListItem`:

```ts
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
```

and populate them in `toListItem`, where each `TargetRow` is mapped:

```ts
      breakerThreshold: target.breakerThreshold,
      breakerCooldownSeconds: target.breakerCooldownSeconds,
```

`getVirtualModel` and `listVirtualModels` both go through `toListItem`, so this is the only mapping site.

- [ ] **Step 5: Add the reset server action**

Append to `src/app/(admin)/models/actions.ts`, matching the file's existing action style:

```ts
export async function resetTargetBreakerAction(formData: FormData): Promise<void> {
  await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const virtualModelId = String(formData.get('virtualModelId') ?? '')

  await getHealthStore().reset(id)
  revalidatePath(`/models/${virtualModelId}`)
}
```

Add `import { getHealthStore } from '@/lib/health'` at the top.

- [ ] **Step 6: Render the column**

In `src/app/(admin)/models/[id]/page.tsx`:

Fetch the views alongside the existing parallel reads:

```ts
  const [providers, warnings, breakers] = await Promise.all([
    listProviders(),
    targetWarnings(),
    targetBreakerViews(model.targets),
  ])
```

Add a component beside the existing `TargetWarningBadge`:

```tsx
function BreakerBadge({ view }: { view: TargetBreakerView | undefined }) {
  // A healthy target renders nothing at all: the normal case is every row
  // healthy, and a column of "closed" badges is noise that hides the one row
  // that matters.
  if (!view || view.state === 'closed') return null
  if (view.state === 'open') {
    return (
      <Badge variant="destructive" title={view.lastError ?? undefined}>
        open{view.reopensIn === null ? '' : ` · ${view.reopensIn}s`}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" title={view.lastError ?? undefined}>half-open</Badge>
  )
}
```

Add `<TableHead>Health</TableHead>` after the `Enabled` head, and the matching cell after the `Enabled` cell:

```tsx
                  <TableCell><BreakerBadge view={breakers.get(target.id)} /></TableCell>
```

Pass the state down to the row actions so the menu item can disable itself:

```tsx
                    <TargetRowActions
                      target={target}
                      virtualModelId={model.id}
                      groups={groupsByProvider[target.providerId] ?? []}
                      breakerState={breakers.get(target.id)?.state ?? 'closed'}
                    />
```

- [ ] **Step 7: Add the menu item**

In `src/app/(admin)/models/target-row-actions.tsx`, accept `breakerState: BreakerState` as a prop and add a `DropdownMenuItem` beside the existing ones:

```tsx
        <DropdownMenuItem
          // Disabled when closed rather than hidden: a reset that silently
          // does nothing reads as a broken button.
          disabled={breakerState === 'closed' || pending}
          onSelect={() => {
            startTransition(async () => {
              const data = new FormData()
              data.set('id', target.id)
              data.set('virtualModelId', virtualModelId)
              try {
                await resetTargetBreakerAction(data)
                toast.success('Breaker reset.')
              } catch {
                toast.error('Could not reset the breaker.')
              }
            })
          }}
        >
          Reset breaker
        </DropdownMenuItem>
```

Import `resetTargetBreakerAction` from `./actions` and `type BreakerState` from `@/lib/health`.

- [ ] **Step 8: Verify**

```bash
pnpm vitest run tests/lib/admin/health.test.ts
pnpm typecheck
pnpm lint
```
Expected: tests PASS, typecheck and lint clean.

- [ ] **Step 9: Commit**

```bash
pnpm test
git add src/lib/admin src/app/\(admin\)/models tests/lib/admin/health.test.ts
git commit -m "feat(dashboard): show breaker state per target with a manual reset"
```

---

### Task 12: Edit the thresholds — per target and globally

**Files:**
- Create: `src/app/(admin)/settings/routing-form.tsx`
- Modify: `src/app/(admin)/models/edit-target-form.tsx`, `src/app/(admin)/models/model-form.tsx` (add-target dialog), `src/app/(admin)/models/actions.ts` (`updateTargetAction`, `addTargetAction`), `src/app/(admin)/models/[id]/page.tsx` (pass the globals down as placeholders), `src/lib/admin/models.ts` (`RouteTargetInput`, `validateTargetFields`, `updateRouteTarget`, `addRouteTarget`), `src/app/(admin)/settings/page.tsx`, `src/app/(admin)/settings/actions.ts`, `src/app/(admin)/settings/usage-status.tsx`
- Test: `tests/lib/admin/models.test.ts` (extend)

**Interfaces:**
- Consumes: `setRoutingSettings`, `clearRoutingSettingsCache` (Task 6); `healthStoreStatus` (Task 5).
- Produces: `RouteTargetInput` gains `breakerThreshold?: number | null` and `breakerCooldownSeconds?: number | null`; `saveRoutingSettingsAction(prev, formData): Promise<ActionState>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/admin/models.test.ts`. That file has a `provider(name = 'p')` helper wrapping `createProvider`, and builds targets through `addRouteTarget`. It will need `eq` and `db`/`routeTargets` imports if they are not already present — check the top of the file first (`db` and `routeTargets` already are):

```ts
async function target() {
  const p = await provider('breaker-p')
  const model = await createVirtualModel({ name: 'breaker-model' })
  return addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: 'm-1' })
}

test('breaker overrides round-trip, and blank clears back to inherit', async () => {
  const row = await target()

  await updateRouteTarget(row.id, { breakerThreshold: 2, breakerCooldownSeconds: 10 })
  let [saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBe(2)
  expect(saved.breakerCooldownSeconds).toBe(10)

  // null is how a blank form field says "inherit the global again".
  await updateRouteTarget(row.id, { breakerThreshold: null, breakerCooldownSeconds: null })
  ;[saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBeNull()
  expect(saved.breakerCooldownSeconds).toBeNull()
})

test('a per-target threshold of 0 is stored, not treated as absent', async () => {
  const row = await target()
  await updateRouteTarget(row.id, { breakerThreshold: 0 })
  const [saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBe(0)
})

test('an invalid override is rejected rather than stored', async () => {
  const row = await target()
  await expect(updateRouteTarget(row.id, { breakerThreshold: -1 })).rejects.toThrow(/threshold/i)
  await expect(updateRouteTarget(row.id, { breakerCooldownSeconds: 0 })).rejects.toThrow(/cooldown/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/admin/models.test.ts`
Expected: FAIL — `breakerThreshold` is not in `RouteTargetInput`.

- [ ] **Step 3: Extend the admin model layer**

`src/lib/admin/models.ts` has **two** input types to extend — `RouteTargetInput` (used by `addRouteTarget`) and the inline object type in `updateRouteTarget`'s signature. Add the same two optional fields to both:

```ts
  breakerThreshold?: number | null
  breakerCooldownSeconds?: number | null
```

Both paths funnel through the shared `validateTargetFields`, so the validation belongs there. Add to it, and note the `!== undefined` guard — `null` means "inherit" and must be storable, while `undefined` means "this update did not mention the field" and must leave the column alone:

```ts
  if (input.breakerThreshold !== undefined) {
    patch.breakerThreshold = validateBreakerThreshold(input.breakerThreshold)
  }
  if (input.breakerCooldownSeconds !== undefined) {
    patch.breakerCooldownSeconds = validateBreakerCooldown(input.breakerCooldownSeconds)
  }
```

In `addRouteTarget`, pass them into the `validateTargetFields({...})` call and then through to `values({...})`:

```ts
    breakerThreshold: validated.breakerThreshold ?? null,
    breakerCooldownSeconds: validated.breakerCooldownSeconds ?? null,
```

Add the validators beside the existing `validateMaxAttempts`:

```ts
/** Null is a value here — it means "inherit the global" — so only a supplied
 *  number is checked. 0 is legal and disables the breaker for this target. */
function validateBreakerThreshold(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('The breaker threshold must be a whole number of failures, 0 or more.')
  }
  return value
}

function validateBreakerCooldown(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('The breaker cooldown must be a whole number of seconds, 1 or more.')
  }
  return value
}
```

- [ ] **Step 4: Add the form fields**

In `src/app/(admin)/models/edit-target-form.tsx` and the add-target dialog in `model-form.tsx`, add two `Input type="number"` fields inside the existing grid, using the shadcn `Label` + `Input` pairing the forms already use:

```tsx
        <div className="space-y-2">
          <Label htmlFor="breakerThreshold">Breaker threshold</Label>
          <Input
            id="breakerThreshold"
            name="breakerThreshold"
            type="number"
            min={0}
            defaultValue={target.breakerThreshold ?? ''}
            placeholder={`${globalThreshold} (inherited)`}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="breakerCooldownSeconds">Breaker cooldown (s)</Label>
          <Input
            id="breakerCooldownSeconds"
            name="breakerCooldownSeconds"
            type="number"
            min={1}
            defaultValue={target.breakerCooldownSeconds ?? ''}
            placeholder={`${globalCooldown} (inherited)`}
          />
        </div>
```

Pass `globalThreshold` / `globalCooldown` down from the page, which already has them via `resolveRoutingSettings()`.

In `actions.ts`, parse blank as `null`:

```ts
/** A blank field means inherit, which is a null — not a 0, and not NaN. */
function optionalInteger(value: FormDataEntryValue | null): number | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw === '' ? null : Number(raw)
}
```

and pass `breakerThreshold: optionalInteger(formData.get('breakerThreshold'))` (and the cooldown) into `updateRouteTarget` / `addRouteTarget`.

- [ ] **Step 5: Add the globals to the Settings page**

In `src/app/(admin)/settings/actions.ts`:

```ts
export async function saveRoutingSettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setRoutingSettings({
      threshold: Number(formData.get('breakerThreshold')),
      cooldownSeconds: Number(formData.get('breakerCooldownSeconds')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }

  // This instance picks the change up immediately. Others converge when their
  // own cache expires.
  clearRoutingSettingsCache()
  revalidatePath('/settings')
  return { success: 'Routing settings saved.' }
}
```

In `src/app/(admin)/settings/page.tsx`, add `getRoutingSettings()` to the existing `Promise.all` and pass its two values into a new `RoutingForm` rendered in the Governance tab below `GovernanceForm`.

Create `src/app/(admin)/settings/routing-form.tsx` as a client component in the shape of `governance-form.tsx` — `useActionState(saveRoutingSettingsAction, undefined)`, the same `useEffect` that toasts `state.error` / `state.success`, and the same `<form action={action} className="max-w-xl space-y-6">` wrapper. Its body:

```tsx
      <div className="space-y-2">
        <Label htmlFor="breakerThreshold">Breaker threshold</Label>
        <Input
          id="breakerThreshold"
          name="breakerThreshold"
          type="number"
          min={0}
          defaultValue={threshold}
        />
        <p className="text-xs text-muted-foreground">
          Consecutive failures before a route target is demoted. 0 disables the
          breaker entirely.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="breakerCooldownSeconds">Breaker cooldown (seconds)</Label>
        <Input
          id="breakerCooldownSeconds"
          name="breakerCooldownSeconds"
          type="number"
          min={1}
          defaultValue={cooldownSeconds}
        />
        <p className="text-xs text-muted-foreground">
          How long a demoted target stays behind its healthy siblings. The first
          request after it lapses probes the target, and a single further
          failure demotes it again. Changes reach other gateway instances within{' '}
          {ttlSeconds} seconds.
        </p>
      </div>
      <Button type="submit" disabled={pending}>Save</Button>
```

Pass `ttlSeconds={ROUTING_SETTINGS_TTL_MS / 1000}` from the page, exactly as `GovernanceForm` already receives `LOG_SETTINGS_TTL_MS / 1000`.

In `src/app/(admin)/settings/usage-status.tsx`, extend the component to take and render a second driver row so `healthStoreStatus()` is displayed beside `usageStoreStatus()`. An operator needs to see when target health is "memory", because that silently means per-instance breakers.

- [ ] **Step 6: Verify**

```bash
pnpm vitest run tests/lib/admin/models.test.ts
pnpm typecheck && pnpm lint
```
Expected: PASS and clean.

- [ ] **Step 7: Check it in a browser**

```bash
pnpm dev:test-db
```

Never `pnpm dev` — that drives the dashboard against the developer's own database on 5432. Open `http://localhost:3001`, add a virtual model with two targets, and confirm: the Health column is empty for healthy targets, the override fields show the inherited values as placeholders and save, the Settings page saves the globals, and the Governance tab names both store drivers.

- [ ] **Step 8: Commit**

```bash
pnpm test
git add src/app/\(admin\) src/lib/admin/models.ts tests/lib/admin/models.test.ts
git commit -m "feat(dashboard): edit breaker thresholds globally and per target"
```

---

### Task 13: Document the breaker

**Files:**
- Modify: `README.md:277-295` (the health-check and "No circuit breaker" limitation)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Replace the stale limitation**

`README.md` currently says:

> - **No circuit breaker.** A provider that is hard down is re-attempted every […]

Delete that bullet and add a section describing what now exists: a per-route-target breaker that opens after N consecutive retryable failures and demotes the target for a cooldown; half-open probing on the next request after the cooldown; that direct `provider/model` addresses are never breakered; that state lives in Redis when `REDIS_URL` is set and per-process otherwise; and that an open breaker demotes rather than excludes, so a total outage still gets attempted.

Carry across the two limitations from the spec that an operator would otherwise discover in production: stream failures after the first chunk are not counted, and settings changes take up to 10 seconds to reach other instances.

- [ ] **Step 2: Verify the claims**

Re-read the bullet against `src/lib/gateway/select.ts` and `src/lib/health/keys.ts`. Every number in the README (threshold 5, cooldown 30s, TTL 10s) must match a constant in the code.

- [ ] **Step 3: Commit**

```bash
pnpm test
git add README.md
git commit -m "docs(readme): describe the target health circuit breaker"
```

---

## Verification

Before declaring the work complete, run all of these and paste the output:

```bash
pnpm test         # expect: > 1009 tests, 0 failures
pnpm typecheck    # expect: clean
pnpm lint         # expect: clean
```

Then confirm each of these by inspection, not assumption:

- [ ] `grep -rn "REDIS_URL" .env.test` returns nothing — the suite still runs on the memory driver by default.
- [ ] `pnpm vitest run tests/lib/health/redis.test.ts` reports 11 passed, not 1 skipped. If it skips, the Redis contract never actually ran.
- [ ] `grep -rn "target_health" src/` returns nothing. The state is in Redis, and no table crept back in.
- [ ] The fail-open guarantee is covered by `tests/gateway/breaker.test.ts` → "routing is unchanged when the health store is unusable", which replaces every store method with a rejecting stub and asserts the down provider is still attempted on every request. That is the real check.

  **Do not** try to verify fail-open by stopping the test Redis and re-running the suite. It does not work, and an earlier draft of this plan wrongly said it would: `tests/lib/health/redis.test.ts` and the pre-existing `tests/lib/usage/redis.test.ts` are gated on `TEST_REDIS_URL` being *set*, not on Redis being *reachable*, so a stopped container fails those 24 driver-contract tests hard rather than skipping them. Those tests exercise the drivers in isolation; the app's fail-open behaviour is a different property, and the mocked-store test above is what proves it.
