# Per-key Usage Counters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count rpm, tpm, and spend per API key in a pluggable store — an
in-process `Map` by default, Redis when `REDIS_URL` is set — and reject
requests from keys that are over their configured limits with a `429`.

**Architecture:** A driver interface that knows nothing about rate limiting
(`apply(ops)` returns each counter's post-increment value; `del`; `status`),
with all window arithmetic, limit comparison, and HTTP behaviour in one shared
module above it. Atomicity comes from `INCRBY`/`INCRBYFLOAT` return values
inside a `MULTI`, never from server-side scripting.

**Tech Stack:** TypeScript, Next.js 16, vitest, drizzle-orm, ioredis.

**Spec:** `docs/superpowers/specs/2026-08-14-usage-counters-design.md`

## Global Constraints

- **Never point tests or a browser check at port 5432.** Tests use the
  disposable Postgres on **5434** (`pnpm test:db:up`); this plan adds a
  disposable Redis on **6380**. See `AGENTS.md`.
- **`.env.test` must contain `TEST_REDIS_URL`, never `REDIS_URL`.** `REDIS_URL`
  is what `getUsageStore()` reads; setting it in `.env.test` would switch the
  whole suite onto the Redis driver.
- **Counter key prefix is `babellm:usage:`** — exact string, used by `del`.
- **Window is 60s**, bucket TTL **120s**, monthly spend TTL **70 days**, total
  spend key has **no TTL**.
- **Month is UTC**, formatted `YYYY-MM`.
- **rpm rejects on `estimate > limit`; tpm and both budgets reject on
  `estimate >= limit`.** The rpm counter already includes the current request;
  the others cannot. Do not "fix" this asymmetry.
- **Breach precedence: rpm, tpm, monthly budget, total budget.**
- **Fail open.** Any store error or timeout: log (throttled), skip the check,
  serve the request, emit no `x-ratelimit-*` headers.
- **A key with no limits configured gets no counters and no store round trip.**
- **Limit rejections are never written to `request_logs`.**
- Run `pnpm lint` and `pnpm typecheck` before every commit.

---

### Task 1: Store interface and the memory driver

**Files:**
- Create: `src/lib/usage/types.ts`
- Create: `src/lib/usage/memory.ts`
- Create: `tests/lib/usage/store-contract.ts`
- Test: `tests/lib/usage/memory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CounterOp`, `UsageStore`, `StoreStatus` from
  `@/lib/usage/types`; `createMemoryStore(): UsageStore` from
  `@/lib/usage/memory`; `describeStoreContract(name, factory)` from
  `tests/lib/usage/store-contract.ts`.

- [ ] **Step 1: Write the shared contract suite**

This file is imported by both driver test files. It is not itself a test file
(no `.test.ts` suffix), so vitest will not pick it up on its own.

Create `tests/lib/usage/store-contract.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import type { UsageStore } from '@/lib/usage/types'

/**
 * The behaviour every driver must have, run once per driver.
 *
 * This exists because the drivers are only interchangeable if they agree, and
 * two separately-written test files drift. `k()` namespaces every key by the
 * driver under test so a shared Redis cannot leak state between runs.
 */
export function describeStoreContract(name: string, create: () => UsageStore) {
  const store = create()
  const ns = `test:${name}:${process.pid}`
  const k = (suffix: string) => `${ns}:${suffix}`

  afterAll(async () => {
    await store.close?.()
  })

  test(`${name}: incrementing returns the value after this op`, async () => {
    const key = k('incr')
    expect(await store.apply([{ key, kind: 'int', by: 1 }])).toEqual([1])
    expect(await store.apply([{ key, kind: 'int', by: 5 }])).toEqual([6])
  })

  test(`${name}: concurrent increments never return the same number`, async () => {
    const key = k('concurrent')
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.apply([{ key, kind: 'int', by: 1 }])),
    )
    const values = results.map(([value]) => value).sort((a, b) => a - b)
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  test(`${name}: by 0 reads without creating the counter`, async () => {
    const key = k('read')
    expect(await store.apply([{ key, kind: 'int', by: 0 }])).toEqual([0])
    // Reading did not bring it into existence: a later increment still
    // starts from zero, and a read of a missing counter is 0, not null.
    expect(await store.apply([{ key, kind: 'int', by: 2 }])).toEqual([2])
  })

  test(`${name}: results come back in the order the ops were given`, async () => {
    const a = k('order-a')
    const b = k('order-b')
    const values = await store.apply([
      { key: a, kind: 'int', by: 3 },
      { key: b, kind: 'int', by: 7 },
      { key: a, kind: 'int', by: 0 },
    ])
    expect(values).toEqual([3, 7, 3])
  })

  test(`${name}: floats accumulate`, async () => {
    const key = k('float')
    await store.apply([{ key, kind: 'float', by: 0.000001 }])
    const [value] = await store.apply([{ key, kind: 'float', by: 0.0000005 }])
    expect(value).toBeCloseTo(0.0000015, 9)
  })

  test(`${name}: a ttl expires the counter`, async () => {
    const key = k('ttl')
    await store.apply([{ key, kind: 'int', by: 1, ttlSeconds: 1 }])
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await store.apply([{ key, kind: 'int', by: 0 }])).toEqual([0])
  })

  test(`${name}: an increment without a ttl leaves an existing ttl alone`, async () => {
    const key = k('ttl-preserved')
    await store.apply([{ key, kind: 'int', by: 1, ttlSeconds: 1 }])
    await store.apply([{ key, kind: 'int', by: 1 }])
    await new Promise((resolve) => setTimeout(resolve, 1100))
    // The compensating decrement on a rejected request must not resurrect a
    // window that was about to expire.
    expect(await store.apply([{ key, kind: 'int', by: 0 }])).toEqual([0])
  })

  test(`${name}: del removes the named counters`, async () => {
    const a = k('del-a')
    const b = k('del-b')
    await store.apply([{ key: a, kind: 'int', by: 4 }, { key: b, kind: 'float', by: 1.5 }])
    await store.del([a, b])
    expect(await store.apply([
      { key: a, kind: 'int', by: 0 },
      { key: b, kind: 'float', by: 0 },
    ])).toEqual([0, 0])
  })

  test(`${name}: an empty op list is a no-op`, async () => {
    expect(await store.apply([])).toEqual([])
  })

  test(`${name}: status reports the driver as usable`, () => {
    expect(store.status()).toEqual({ healthy: true, error: null })
  })
}
```

- [ ] **Step 2: Write the memory driver's test file**

Create `tests/lib/usage/memory.test.ts`:

```ts
import { createMemoryStore } from '@/lib/usage/memory'
import { describeStoreContract } from './store-contract'

describeStoreContract('memory', createMemoryStore)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/lib/usage/memory.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage/memory`.

- [ ] **Step 4: Write the types**

Create `src/lib/usage/types.ts`:

```ts
/** One counter mutation. `by: 0` is a read. */
export interface CounterOp {
  key: string
  /** Integer counters use INCRBY; money uses INCRBYFLOAT. */
  kind: 'int' | 'float'
  by: number
  /** Seconds. Applied on write; omitted leaves any existing expiry alone. */
  ttlSeconds?: number
}

export interface StoreStatus {
  healthy: boolean
  error: string | null
}

export interface UsageStore {
  readonly name: string
  /**
   * Applies every op in one round trip and returns each counter's value
   * *after* this op's contribution, in the order the ops were given.
   *
   * The return value is the atomicity: two concurrent callers incrementing
   * the same counter get different numbers back, so each can decide for
   * itself whether it was the one that crossed a line. That is why this
   * needs no server-side scripting.
   */
  apply(ops: CounterOp[]): Promise<number[]>
  /** Delete counters outright. The caller names them — a driver has no idea
   * what an API key is. */
  del(keys: string[]): Promise<void>
  /** Last known state, for the Governance tab. Never initiates a connection. */
  status(): StoreStatus
  close?(): Promise<void>
}
```

- [ ] **Step 5: Write the memory driver**

Create `src/lib/usage/memory.ts`:

```ts
import type { CounterOp, StoreStatus, UsageStore } from './types'

interface Entry {
  value: number
  /** Epoch ms, or null for "never expires". */
  expiresAt: number | null
}

/** Dead minute buckets are dropped on read, but a key that stops being used
 * is never read again — hence a sweep, purely for memory hygiene. */
const SWEEP_INTERVAL_MS = 60_000

export function createMemoryStore(): UsageStore {
  const counters = new Map<string, Entry>()

  /** Reads through expiry: an entry past its time is indistinguishable from
   * one that never existed, which is what Redis does too. */
  function live(key: string, now: number): Entry | undefined {
    const entry = counters.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      counters.delete(key)
      return undefined
    }
    return entry
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of counters) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) counters.delete(key)
    }
  }, SWEEP_INTERVAL_MS)
  // Never hold the process open for bookkeeping.
  sweep.unref()

  return {
    name: 'memory',

    async apply(ops: CounterOp[]): Promise<number[]> {
      // Single process, single thread: the whole loop runs without
      // interleaving, so every op is atomic for free.
      const now = Date.now()
      return ops.map((op) => {
        const entry = live(op.key, now)
        if (op.by === 0) return entry?.value ?? 0
        const value = (entry?.value ?? 0) + op.by
        counters.set(op.key, {
          value,
          expiresAt:
            op.ttlSeconds === undefined
              ? (entry?.expiresAt ?? null)
              : now + op.ttlSeconds * 1000,
        })
        return value
      })
    },

    async del(keys: string[]): Promise<void> {
      for (const key of keys) counters.delete(key)
    },

    status(): StoreStatus {
      // A Map cannot be unreachable.
      return { healthy: true, error: null }
    },

    async close(): Promise<void> {
      clearInterval(sweep)
      counters.clear()
    },
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/usage/memory.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/usage/types.ts src/lib/usage/memory.ts tests/lib/usage
git commit -m "feat(usage): counter store interface and in-memory driver"
```

---

### Task 2: Redis driver and the disposable test Redis

**Files:**
- Create: `src/lib/usage/redis.ts`
- Test: `tests/lib/usage/redis.test.ts`
- Modify: `package.json` (add `ioredis`)
- Modify: `docker-compose.test.yml` (add `redis-test` on 6380)
- Modify: `.env.test.example` (add `TEST_REDIS_URL`)

**Interfaces:**
- Consumes: `CounterOp`, `StoreStatus`, `UsageStore` from `@/lib/usage/types`;
  `describeStoreContract` from `tests/lib/usage/store-contract.ts`.
- Produces: `createRedisStore(url: string): UsageStore` from
  `@/lib/usage/redis`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add ioredis@5.9.0
```

- [ ] **Step 2: Add the disposable Redis**

Append to `docker-compose.test.yml`, inside the existing `services:` block
(the file already pins `name: babellm-test`):

```yaml
  redis-test:
    image: redis:7-alpine
    # Nothing here is worth resurrecting; it dies with the container.
    restart: "no"
    # 6380, not 6379: a developer's own Redis keeps the default port, the way
    # the test Postgres leaves 5432 to theirs.
    ports:
      - "6380:6379"
    # No persistence at all. The usage counters are volatile by design, and a
    # test container that wrote an RDB would be the one place in this repo
    # where they were not.
    command: redis-server --save "" --appendonly no
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30
```

- [ ] **Step 3: Add the test URL to the example env**

Append to `.env.test.example`:

```
# The disposable Redis from docker-compose.test.yml. Deliberately NOT named
# REDIS_URL: that is what getUsageStore() reads, so setting it here would put
# the entire suite on the Redis driver and make every test need a container.
# Only tests/lib/usage/redis.test.ts reads this, and it skips without it.
TEST_REDIS_URL=redis://localhost:6380
```

Then refresh your own copy:

```bash
cp .env.test.example .env.test
```

- [ ] **Step 4: Write the Redis driver's test file**

Create `tests/lib/usage/redis.test.ts`:

```ts
import { test } from 'vitest'
import { createRedisStore } from '@/lib/usage/redis'
import { describeStoreContract } from './store-contract'

const url = process.env.TEST_REDIS_URL

if (url) {
  describeStoreContract('redis', () => createRedisStore(url))
} else {
  test.skip('redis driver contract (set TEST_REDIS_URL and run pnpm test:db:up)', () => {})
}
```

- [ ] **Step 5: Start the container and run the test to verify it fails**

```bash
pnpm test:db:up
pnpm vitest run tests/lib/usage/redis.test.ts
```

Expected: FAIL — cannot resolve `@/lib/usage/redis`.

- [ ] **Step 6: Write the Redis driver**

Create `src/lib/usage/redis.ts`:

```ts
import Redis from 'ioredis'
import type { CounterOp, StoreStatus, UsageStore } from './types'

export function createRedisStore(url: string): UsageStore {
  const redis = new Redis(url, {
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
  redis.on('error', (err: Error) => {
    lastError = err.message
  })
  redis.on('ready', () => {
    lastError = null
  })

  return {
    name: 'redis',

    async apply(ops: CounterOp[]): Promise<number[]> {
      if (ops.length === 0) return []

      // MULTI, not a plain pipeline: it keeps a counter's INCRBY and its
      // EXPIRE from being separated, so a crash cannot leave a window
      // counter with no expiry. It never needs to branch mid-transaction,
      // which is the only thing a Lua script would have added.
      const tx = redis.multi()
      for (const op of ops) {
        if (op.by === 0) {
          tx.get(op.key)
          continue
        }
        if (op.kind === 'float') tx.incrbyfloat(op.key, op.by)
        else tx.incrby(op.key, op.by)
        if (op.ttlSeconds !== undefined) tx.expire(op.key, op.ttlSeconds)
      }

      const results = await tx.exec()
      if (!results) throw new Error('redis transaction was aborted')

      // Walk the replies in the order the commands were queued, skipping the
      // EXPIRE reply that follows an op that asked for a ttl.
      const values: number[] = []
      let at = 0
      for (const op of ops) {
        const [err, raw] = results[at]
        at += 1
        if (err) throw err
        // A missing counter reads as 0. Unlike prices, a counter genuinely
        // starts at zero — there is no "not measured" state to preserve.
        values.push(raw === null ? 0 : Number(raw))
        if (op.by !== 0 && op.ttlSeconds !== undefined) at += 1
      }
      return values
    },

    async del(keys: string[]): Promise<void> {
      if (keys.length > 0) await redis.del(...keys)
    },

    status(): StoreStatus {
      const healthy = redis.status === 'ready' && lastError === null
      return { healthy, error: healthy ? null : (lastError ?? redis.status) }
    },

    async close(): Promise<void> {
      redis.disconnect()
    },
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run tests/lib/usage/redis.test.ts`
Expected: PASS (10 tests, the same ones the memory driver passed).

- [ ] **Step 8: Verify it skips cleanly without the container**

`tests/setup/env.ts` loads `.env.test` with `override: true`, so a
`TEST_REDIS_URL=` prefix on the command line gets overwritten by the value
already in `.env.test` and does not actually unset it. Verify the skip path
by removing the line from `.env.test` itself, running the test, then
restoring it:

```bash
cp .env.test /tmp/env.test.bak
grep -v TEST_REDIS_URL .env.test > /tmp/env.test.noredis && mv /tmp/env.test.noredis .env.test
pnpm vitest run tests/lib/usage/redis.test.ts
cp /tmp/env.test.bak .env.test
```

Expected: 1 skipped, 0 failed. A fresh checkout that has not run
`pnpm test:db:up` must not see a red suite.

- [ ] **Step 9: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add package.json pnpm-lock.yaml docker-compose.test.yml .env.test.example \
        src/lib/usage/redis.ts tests/lib/usage/redis.test.ts
git commit -m "feat(usage): redis driver and a disposable redis for tests"
```

---

### Task 3: Counter names and window arithmetic

**Files:**
- Create: `src/lib/usage/keys.ts`
- Test: `tests/lib/usage/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all from `@/lib/usage/keys`: `PREFIX`, `WINDOW_MS`,
  `WINDOW_TTL_SECONDS`, `MONTH_TTL_SECONDS`, `bucketOf(now: number): number`,
  `monthOf(now: number): string`,
  `windowKey(kind: 'rpm' | 'tpm', keyId: string, bucket: number): string`,
  `monthlySpendKey(keyId: string, now: number): string`,
  `totalSpendKey(keyId: string): string`,
  `allKeysFor(keyId: string, now: number): string[]`,
  `estimate(previous: number, current: number, now: number): number`,
  `secondsToWindowEnd(now: number): number`,
  `secondsToMonthEnd(now: number): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/usage/keys.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  allKeysFor, bucketOf, estimate, monthOf, monthlySpendKey, secondsToMonthEnd,
  secondsToWindowEnd, totalSpendKey, windowKey,
} from '@/lib/usage/keys'

const AUG_14 = Date.UTC(2026, 7, 14, 10, 30, 15, 0)

test('a bucket is the minute a request lands in', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  expect(bucketOf(AUG_14)).toBe(minuteStart / 60_000)
  expect(bucketOf(minuteStart + 59_999)).toBe(bucketOf(AUG_14))
  expect(bucketOf(minuteStart + 60_000)).toBe(bucketOf(AUG_14) + 1)
})

test('the month is UTC, zero padded', () => {
  expect(monthOf(AUG_14)).toBe('2026-08')
  expect(monthOf(Date.UTC(2026, 0, 1))).toBe('2026-01')
  // 23:30 on the 31st in UTC+2 is still January to this gateway.
  expect(monthOf(Date.UTC(2026, 0, 31, 23, 30))).toBe('2026-01')
})

test('counter names are namespaced and stable', () => {
  expect(windowKey('rpm', 'abc', 100)).toBe('babellm:usage:rpm:abc:100')
  expect(windowKey('tpm', 'abc', 100)).toBe('babellm:usage:tpm:abc:100')
  expect(monthlySpendKey('abc', AUG_14)).toBe('babellm:usage:spend:abc:2026-08')
  expect(totalSpendKey('abc')).toBe('babellm:usage:spend:abc:total')
})

test('allKeysFor names everything a deleted key could still own', () => {
  const bucket = bucketOf(AUG_14)
  expect(allKeysFor('abc', AUG_14).sort()).toEqual([
    windowKey('rpm', 'abc', bucket - 1),
    windowKey('rpm', 'abc', bucket),
    windowKey('tpm', 'abc', bucket - 1),
    windowKey('tpm', 'abc', bucket),
    monthlySpendKey('abc', AUG_14),
    totalSpendKey('abc'),
  ].sort())
})

test('the sliding window weights the previous bucket by what is left of it', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  // Exactly on the boundary: the previous minute counts in full.
  expect(estimate(100, 0, minuteStart)).toBeCloseTo(100, 6)
  // A quarter of the way in: three quarters of it remains.
  expect(estimate(100, 0, minuteStart + 15_000)).toBeCloseTo(75, 6)
  // Nearly through: almost none of it.
  expect(estimate(100, 0, minuteStart + 59_999)).toBeCloseTo(0.0017, 3)
  // The current bucket always counts in full.
  expect(estimate(100, 8, minuteStart + 30_000)).toBeCloseTo(58, 6)
})

test('reset seconds count to the end of the current window', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  expect(secondsToWindowEnd(minuteStart)).toBe(60)
  expect(secondsToWindowEnd(minuteStart + 30_000)).toBe(30)
  // Never zero: "retry immediately" would be a lie inside the window.
  expect(secondsToWindowEnd(minuteStart + 59_999)).toBe(1)
})

test('reset seconds for a budget count to the first of the next month, UTC', () => {
  const oneDay = 24 * 60 * 60
  expect(secondsToMonthEnd(Date.UTC(2026, 7, 31, 0, 0, 0))).toBe(oneDay)
  expect(secondsToMonthEnd(Date.UTC(2026, 11, 31, 12, 0, 0))).toBe(oneDay / 2)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/usage/keys.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage/keys`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/usage/keys.ts`:

```ts
/**
 * Counter names and window arithmetic.
 *
 * Every function here is pure and takes `now` explicitly, so the awkward
 * moments — a bucket boundary, the first of the month — are tested by passing
 * a number rather than by mocking a clock.
 */

/** Namespaced so a shared Redis stays legible and `del` is a bounded list. */
export const PREFIX = 'babellm:usage'

export const WINDOW_MS = 60_000
/** Two windows: the current bucket and the previous one the estimate reads. */
export const WINDOW_TTL_SECONDS = 120
/** Long enough that last month is still readable during this one, short
 * enough that months do not accumulate. Refreshed on every write. */
export const MONTH_TTL_SECONDS = 70 * 24 * 60 * 60

export function bucketOf(now: number): number {
  return Math.floor(now / WINDOW_MS)
}

export function monthOf(now: number): string {
  const date = new Date(now)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}`
}

export function windowKey(kind: 'rpm' | 'tpm', keyId: string, bucket: number): string {
  return `${PREFIX}:${kind}:${keyId}:${bucket}`
}

export function monthlySpendKey(keyId: string, now: number): string {
  return `${PREFIX}:spend:${keyId}:${monthOf(now)}`
}

/** The one counter with no expiry, which is why deleting a key must name it. */
export function totalSpendKey(keyId: string): string {
  return `${PREFIX}:spend:${keyId}:total`
}

/**
 * Every counter a key could still own right now.
 *
 * Older minute buckets and earlier months are already expiring on their own,
 * so this stays a fixed six names — no SCAN, and no unbounded delete.
 */
export function allKeysFor(keyId: string, now: number): string[] {
  const bucket = bucketOf(now)
  return [
    windowKey('rpm', keyId, bucket),
    windowKey('rpm', keyId, bucket - 1),
    windowKey('tpm', keyId, bucket),
    windowKey('tpm', keyId, bucket - 1),
    monthlySpendKey(keyId, now),
    totalSpendKey(keyId),
  ]
}

/**
 * The sliding window estimate: the current bucket in full, plus however much
 * of the previous one has not yet rolled off.
 *
 * A fixed window would let a key spend its whole allowance in the last second
 * of one minute and again in the first second of the next. This costs one
 * extra read in a batch that was already being sent.
 */
export function estimate(previous: number, current: number, now: number): number {
  const elapsed = (now % WINDOW_MS) / WINDOW_MS
  return previous * (1 - elapsed) + current
}

/** Seconds until the offending minute has certainly rolled off. A sliding
 * window relieves gradually, so this is an honest floor rather than an exact
 * answer. Never 0 — that would read as "retry now". */
export function secondsToWindowEnd(now: number): number {
  return Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000)
}

export function secondsToMonthEnd(now: number): number {
  const date = new Date(now)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return Math.ceil((next - now) / 1000)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/lib/usage/keys.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/usage/keys.ts tests/lib/usage/keys.test.ts
git commit -m "feat(usage): counter names and sliding window arithmetic"
```

---

### Task 4: Driver resolution from REDIS_URL

**Files:**
- Create: `src/lib/usage/registry.ts`
- Test: `tests/lib/usage/registry.test.ts`

**Interfaces:**
- Consumes: `createMemoryStore` (Task 1), `createRedisStore` (Task 2),
  `UsageStore`/`StoreStatus` from `@/lib/usage/types`.
- Produces, from `@/lib/usage/registry`: `getUsageStore(): UsageStore`,
  `resetUsageStore(): void`, `usageStoreStatus(): { driver: string } & StoreStatus`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/usage/registry.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { getUsageStore, resetUsageStore, usageStoreStatus } from '@/lib/usage/registry'

const original = process.env.REDIS_URL

beforeEach(() => {
  resetUsageStore()
})

afterEach(() => {
  if (original === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = original
  resetUsageStore()
})

test('no REDIS_URL resolves the memory driver', () => {
  delete process.env.REDIS_URL
  expect(getUsageStore().name).toBe('memory')
  expect(usageStoreStatus()).toEqual({ driver: 'memory', healthy: true, error: null })
})

test('REDIS_URL resolves the redis driver', () => {
  // Never connected to; the driver is constructed lazily enough that
  // resolution itself does not need a reachable server.
  process.env.REDIS_URL = 'redis://localhost:6399'
  expect(getUsageStore().name).toBe('redis')
  expect(usageStoreStatus().driver).toBe('redis')
})

test('the store is resolved once and reused', () => {
  delete process.env.REDIS_URL
  expect(getUsageStore()).toBe(getUsageStore())
})

test('an empty REDIS_URL is treated as unset', () => {
  // An empty environment variable is how a compose file spells "not
  // configured"; it must not produce a redis client pointed at nothing.
  process.env.REDIS_URL = ''
  expect(getUsageStore().name).toBe('memory')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/usage/registry.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage/registry`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/usage/registry.ts`:

```ts
import 'server-only'
import { createMemoryStore } from './memory'
import { createRedisStore } from './redis'
import type { StoreStatus, UsageStore } from './types'

let store: UsageStore | null = null

/**
 * The configured store, resolved once.
 *
 * `REDIS_URL` rather than a settings row: this is infrastructure, like
 * `DATABASE_URL` and `ENCRYPTION_KEY`, and keeping it in the environment
 * means a Redis credential never lives in the database and nobody can take
 * the gateway's counters away from the dashboard.
 */
export function getUsageStore(): UsageStore {
  if (store) return store
  const url = process.env.REDIS_URL?.trim()
  store = url ? createRedisStore(url) : createMemoryStore()
  return store
}

/** Tests only. Drops the resolved store and any connection it holds. */
export function resetUsageStore(): void {
  void store?.close?.()
  store = null
}

export function usageStoreStatus(): { driver: string } & StoreStatus {
  const resolved = getUsageStore()
  return { driver: resolved.name, ...resolved.status() }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/lib/usage/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/usage/registry.ts tests/lib/usage/registry.test.ts
git commit -m "feat(usage): resolve the counter store from REDIS_URL"
```

---

### Task 5: The limits module

This is the only module that knows what a limit is. Everything about product
behaviour lives here.

**Files:**
- Create: `src/lib/usage/limits.ts`
- Create: `src/lib/usage/index.ts`
- Test: `tests/lib/usage/limits.test.ts`

**Interfaces:**
- Consumes: `getUsageStore` (Task 4), everything from `@/lib/usage/keys`
  (Task 3), `CounterOp` from `@/lib/usage/types`, `GatewayError` from
  `@/lib/gateway/errors`.
- Produces, from `@/lib/usage` (re-exported by `index.ts`):
  - `interface KeyLimits { id: string; rpmLimit: number | null; tpmLimit: number | null; budgetMonthlyUsd: string | null; budgetTotalUsd: string | null }`
  - `interface UsageReading { rpm: number | null; tpm: number | null; monthUsd: number | null; totalUsd: number | null }`
  - `interface LimitSnapshot { rpm: { limit: number; remaining: number; resetSeconds: number } | null; tpm: { limit: number; remaining: number; resetSeconds: number } | null }`
  - `class LimitExceededError extends GatewayError { readonly headers: Record<string, string> }`
  - `hasLimits(key: KeyLimits): boolean`
  - `checkLimits(key: KeyLimits, now?: number): Promise<LimitSnapshot | null>`
  - `chargeUsage(key: KeyLimits, tokens: number, costUsd: string | null, now?: number): Promise<void>`
  - `rateLimitHeaders(snapshot: LimitSnapshot | null): Record<string, string>`
  - `readUsage(keys: KeyLimits[], now?: number): Promise<Map<string, UsageReading>>`
  - `clearUsage(keyId: string, now?: number): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/usage/limits.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  LimitExceededError, chargeUsage, checkLimits, clearUsage, hasLimits,
  rateLimitHeaders, readUsage, type KeyLimits,
} from '@/lib/usage'
import { resetUsageStore } from '@/lib/usage/registry'

function key(over: Partial<KeyLimits> = {}): KeyLimits {
  return {
    id: 'key-1',
    rpmLimit: null,
    tpmLimit: null,
    budgetMonthlyUsd: null,
    budgetTotalUsd: null,
    ...over,
  }
}

/** Returns the rejection, or fails the test if the call was allowed.
 * `.catch(e => e as X)` would type the result as the union of the resolved
 * and rejected values, so every assertion on it would need a cast. */
async function rejection(k: KeyLimits): Promise<LimitExceededError> {
  try {
    await checkLimits(k)
  } catch (err) {
    return err as LimitExceededError
  }
  throw new Error('expected checkLimits to reject, but it allowed the request')
}

/** The compensating decrement on a rejected request is fire-and-forget, so a
 * test asserting on the counter has to wait for it. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

beforeEach(() => {
  delete process.env.REDIS_URL
  resetUsageStore()
})

afterEach(() => {
  resetUsageStore()
})

test('a key with no limits is not counted at all', async () => {
  expect(hasLimits(key())).toBe(false)
  expect(await checkLimits(key())).toBeNull()
  // Nothing was written, so nothing can be read back.
  const readings = await readUsage([key()])
  expect(readings.get('key-1')).toEqual({
    rpm: null, tpm: null, monthUsd: null, totalUsd: null,
  })
})

test('requests are allowed up to the rpm limit and rejected after it', async () => {
  const k = key({ rpmLimit: 2 })
  await expect(checkLimits(k)).resolves.not.toBeNull()
  await expect(checkLimits(k)).resolves.not.toBeNull()
  await expect(checkLimits(k)).rejects.toBeInstanceOf(LimitExceededError)
})

test('a rejected request does not consume rpm', async () => {
  const k = key({ rpmLimit: 1 })
  await checkLimits(k)
  await rejection(k)
  await rejection(k)
  await settled()

  // Still exactly the one served request: a client that ignores 429s cannot
  // extend its own lockout.
  const readings = await readUsage([k])
  expect(readings.get('key-1')?.rpm).toBe(1)
})

test('the rejection carries Retry-After and a rate limit code', async () => {
  const k = key({ rpmLimit: 1 })
  await checkLimits(k)
  const err = await rejection(k)

  expect(err).toBeInstanceOf(LimitExceededError)
  expect(err.status).toBe(429)
  expect(err.code).toBe('rate_limit_exceeded')
  expect(Number(err.headers['retry-after'])).toBeGreaterThan(0)
  expect(err.headers['x-ratelimit-remaining-requests']).toBe('0')
})

test('tpm is charged after the request and rejects the next one', async () => {
  const k = key({ tpmLimit: 100 })
  await checkLimits(k)
  await chargeUsage(k, 100, null)

  // Check before, charge after: the request that crossed the line was
  // served, and it is the following one that pays for it.
  await expect(checkLimits(k)).rejects.toMatchObject({ code: 'rate_limit_exceeded' })
})

test('a budget rejects with insufficient_quota once spend reaches it', async () => {
  const k = key({ budgetTotalUsd: '0.01' })
  await checkLimits(k)
  await chargeUsage(k, 0, '0.010000000')

  const err = await rejection(k)
  expect(err.code).toBe('insufficient_quota')
  // A total budget never recovers, so promising a retry time would be a lie.
  expect(err.headers['retry-after']).toBeUndefined()
})

test('a monthly budget promises a retry at the turn of the month', async () => {
  const k = key({ budgetMonthlyUsd: '0.01' })
  await chargeUsage(k, 0, '0.02')
  const err = await rejection(k)

  expect(err.code).toBe('insufficient_quota')
  expect(Number(err.headers['retry-after'])).toBeGreaterThan(0)
})

test('rpm is reported before budget when both are breached', async () => {
  const k = key({ rpmLimit: 1, budgetTotalUsd: '0.01' })
  // The one request rpm allows, which then spends the whole budget.
  await checkLimits(k)
  await chargeUsage(k, 0, '1.00')

  const err = await rejection(k)

  // Both are breached now. The condition that clears on its own is the more
  // useful thing to be told.
  expect(err.code).toBe('rate_limit_exceeded')
})

test('a key that is over budget never accumulates rpm', async () => {
  const k = key({ rpmLimit: 10, budgetTotalUsd: '0.01' })
  await chargeUsage(k, 0, '1.00')

  for (let i = 0; i < 3; i += 1) {
    expect((await rejection(k)).code).toBe('insufficient_quota')
  }
  await settled()

  // Every one of those was compensated, so the window stayed empty. This is
  // what "rejections do not consume rpm" means for a key that can never be
  // served: it does not silently work its way into a second kind of breach.
  expect((await readUsage([k])).get('key-1')?.rpm).toBe(0)
})

test('an unpriced request charges tokens but no money', async () => {
  const k = key({ tpmLimit: 1000, budgetTotalUsd: '1' })
  await chargeUsage(k, 40, null)

  const reading = (await readUsage([k])).get('key-1')
  expect(reading?.tpm).toBe(40)
  // computeCost returns null rather than 0 for a model with no price, and a
  // budget must not be spent by a number nobody measured.
  expect(reading?.totalUsd).toBe(0)
})

test('headers describe only the limits the key has', async () => {
  const snapshot = await checkLimits(key({ rpmLimit: 10 }))
  const headers = rateLimitHeaders(snapshot)

  expect(headers['x-ratelimit-limit-requests']).toBe('10')
  expect(headers['x-ratelimit-remaining-requests']).toBe('9')
  expect(Number(headers['x-ratelimit-reset-requests'])).toBeGreaterThan(0)
  expect(headers['x-ratelimit-limit-tokens']).toBeUndefined()
})

test('a store failure fails open and emits no headers', async () => {
  const k = key({ rpmLimit: 1 })
  const store = (await import('@/lib/usage/registry')).getUsageStore()
  store.apply = async () => { throw new Error('redis is down') }

  // No throw, no opinion: a counter store outage must not become a gateway
  // outage.
  expect(await checkLimits(k)).toBeNull()
  expect(rateLimitHeaders(null)).toEqual({})
})

test('clearUsage forgets a deleted key', async () => {
  const k = key({ rpmLimit: 10, budgetTotalUsd: '1' })
  await checkLimits(k)
  await chargeUsage(k, 0, '0.5')

  await clearUsage('key-1')

  const reading = (await readUsage([k])).get('key-1')
  expect(reading).toEqual({ rpm: 0, tpm: null, monthUsd: null, totalUsd: 0 })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/usage/limits.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage`.

- [ ] **Step 3: Write the limits module**

Create `src/lib/usage/limits.ts`:

```ts
import 'server-only'
import { GatewayError } from '@/lib/gateway/errors'
import {
  MONTH_TTL_SECONDS, WINDOW_TTL_SECONDS, allKeysFor, bucketOf, estimate,
  monthlySpendKey, secondsToMonthEnd, secondsToWindowEnd, totalSpendKey, windowKey,
} from './keys'
import { getUsageStore } from './registry'
import type { CounterOp } from './types'

/** The subset of an api_keys row this module needs. A structural type rather
 * than ApiKeyRow so the admin list can pass its own projection. */
export interface KeyLimits {
  id: string
  rpmLimit: number | null
  tpmLimit: number | null
  budgetMonthlyUsd: string | null
  budgetTotalUsd: string | null
}

/** What a key has actually used. `null` means "not counted" — the key has no
 * limit of that kind — which must not render as 0. */
export interface UsageReading {
  rpm: number | null
  tpm: number | null
  monthUsd: number | null
  totalUsd: number | null
}

export interface LimitSnapshot {
  rpm: { limit: number; remaining: number; resetSeconds: number } | null
  tpm: { limit: number; remaining: number; resetSeconds: number } | null
}

/**
 * A request rejected by this module, and only by this module.
 *
 * Its own class rather than a status check: an upstream provider's 429
 * reaching the handler's catch is a completely different event that must
 * still be logged, and `status === 429` cannot tell them apart.
 */
export class LimitExceededError extends GatewayError {
  readonly headers: Record<string, string>

  constructor(init: {
    code: 'rate_limit_exceeded' | 'insufficient_quota'
    message: string
    headers: Record<string, string>
  }) {
    super({ status: 429, type: 'rate_limit_error', code: init.code, message: init.message })
    this.name = 'LimitExceededError'
    this.headers = init.headers
  }
}

export function hasLimits(key: KeyLimits): boolean {
  return key.rpmLimit !== null
    || key.tpmLimit !== null
    || key.budgetMonthlyUsd !== null
    || key.budgetTotalUsd !== null
}

/** One line per outage rather than one per request. A Redis failure under
 * load must not cost more in stderr than the outage costs in service. */
const FAILURE_LOG_INTERVAL_MS = 10_000
let lastFailureLoggedAt = 0

function reportFailure(err: unknown): void {
  const now = Date.now()
  if (now - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLoggedAt = now
  console.error('[gateway] usage counter store failed; limits not enforced', err)
}

/**
 * Decides whether this request may proceed, and counts it if it may.
 *
 * Returns the snapshot the response headers are built from, or `null` when no
 * decision was made — the key has no limits, or the store was unreachable.
 * Throws `LimitExceededError` when a limit is breached.
 */
export async function checkLimits(
  key: KeyLimits,
  now: number = Date.now(),
): Promise<LimitSnapshot | null> {
  if (!hasLimits(key)) return null

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []
  const at: Record<string, number> = {}
  const push = (name: string, op: CounterOp) => {
    at[name] = ops.length
    ops.push(op)
  }

  // rpm is the only counter incremented here: this request is the one being
  // decided, and INCRBY's return value is what makes that decision safe
  // under concurrency.
  if (key.rpmLimit !== null) {
    push('rpmCurrent', {
      key: windowKey('rpm', key.id, bucket), kind: 'int', by: 1,
      ttlSeconds: WINDOW_TTL_SECONDS,
    })
    push('rpmPrevious', { key: windowKey('rpm', key.id, bucket - 1), kind: 'int', by: 0 })
  }
  // tpm is read, never incremented here: this request's token count does not
  // exist yet.
  if (key.tpmLimit !== null) {
    push('tpmCurrent', { key: windowKey('tpm', key.id, bucket), kind: 'int', by: 0 })
    push('tpmPrevious', { key: windowKey('tpm', key.id, bucket - 1), kind: 'int', by: 0 })
  }
  if (key.budgetMonthlyUsd !== null) {
    push('month', { key: monthlySpendKey(key.id, now), kind: 'float', by: 0 })
  }
  if (key.budgetTotalUsd !== null) {
    push('total', { key: totalSpendKey(key.id), kind: 'float', by: 0 })
  }

  let values: number[]
  try {
    values = await getUsageStore().apply(ops)
  } catch (err) {
    // Fail open. Availability beats enforcement: a store blip must not take
    // the gateway down with it.
    reportFailure(err)
    return null
  }

  const value = (name: string) => (at[name] === undefined ? 0 : values[at[name]])

  const rpm = key.rpmLimit === null
    ? null
    : estimate(value('rpmPrevious'), value('rpmCurrent'), now)
  const tpm = key.tpmLimit === null
    ? null
    : estimate(value('tpmPrevious'), value('tpmCurrent'), now)

  const snapshot: LimitSnapshot = {
    rpm: key.rpmLimit === null ? null : {
      limit: key.rpmLimit,
      remaining: Math.max(0, Math.floor(key.rpmLimit - (rpm ?? 0))),
      resetSeconds: secondsToWindowEnd(now),
    },
    tpm: key.tpmLimit === null ? null : {
      limit: key.tpmLimit,
      remaining: Math.max(0, Math.floor(key.tpmLimit - (tpm ?? 0))),
      resetSeconds: secondsToWindowEnd(now),
    },
  }

  /** Undo this request's rpm tick. A client that ignores its 429s must not be
   * able to extend its own lockout. Fire and forget on a path that is already
   * failing; if the process dies first the window reads one high until it
   * expires, which is the whole price of not using server-side scripting. */
  const compensate = () => {
    if (key.rpmLimit === null) return
    // No ttlSeconds: the window's existing expiry must survive the undo.
    void getUsageStore()
      .apply([{ key: windowKey('rpm', key.id, bucket), kind: 'int', by: -1 }])
      .catch(reportFailure)
  }

  // Precedence: rpm, tpm, monthly budget, total budget. A key that is both
  // throttled and out of budget is told it is throttled, because that is the
  // condition that will clear on its own.
  //
  // `>` for rpm because its counter already includes this request — the
  // question is whether this request fits. `>=` for everything else because
  // their counters cannot include it — the question is whether there is any
  // room left at all.
  if (rpm !== null && key.rpmLimit !== null && rpm > key.rpmLimit) {
    compensate()
    throw new LimitExceededError({
      code: 'rate_limit_exceeded',
      message: `Rate limit reached for this API key: ${key.rpmLimit} requests per minute.`,
      // `remaining` is already 0 here — it is computed as
      // max(0, limit - estimate), and we only get here when estimate > limit.
      headers: {
        'retry-after': String(secondsToWindowEnd(now)),
        ...rateLimitHeaders(snapshot),
      },
    })
  }

  if (tpm !== null && key.tpmLimit !== null && tpm >= key.tpmLimit) {
    compensate()
    throw new LimitExceededError({
      code: 'rate_limit_exceeded',
      message: `Rate limit reached for this API key: ${key.tpmLimit} tokens per minute.`,
      headers: {
        'retry-after': String(secondsToWindowEnd(now)),
        ...rateLimitHeaders(snapshot),
      },
    })
  }

  if (key.budgetMonthlyUsd !== null && value('month') >= Number(key.budgetMonthlyUsd)) {
    compensate()
    throw new LimitExceededError({
      code: 'insufficient_quota',
      message: `This API key has reached its monthly budget of $${key.budgetMonthlyUsd}.`,
      headers: { 'retry-after': String(secondsToMonthEnd(now)) },
    })
  }

  if (key.budgetTotalUsd !== null && value('total') >= Number(key.budgetTotalUsd)) {
    compensate()
    // No Retry-After: a total budget never recovers on its own, and naming a
    // time would promise something no clock will deliver.
    throw new LimitExceededError({
      code: 'insufficient_quota',
      message: `This API key has reached its total budget of $${key.budgetTotalUsd}.`,
      headers: {},
    })
  }

  return snapshot
}

/**
 * Records what the request actually used, once it is known.
 *
 * Never throws: this runs after the response and must not be able to fail one.
 */
export async function chargeUsage(
  key: KeyLimits,
  tokens: number,
  costUsd: string | null,
  now: number = Date.now(),
): Promise<void> {
  if (!hasLimits(key)) return

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []

  if (key.tpmLimit !== null && tokens > 0) {
    ops.push({
      key: windowKey('tpm', key.id, bucket), kind: 'int', by: tokens,
      ttlSeconds: WINDOW_TTL_SECONDS,
    })
  }

  // null, not 0: an unpriced model measured no money, and a budget must not
  // be spent by a number nobody measured.
  const cost = costUsd === null ? 0 : Number(costUsd)
  if (cost > 0) {
    if (key.budgetMonthlyUsd !== null) {
      ops.push({
        key: monthlySpendKey(key.id, now), kind: 'float', by: cost,
        ttlSeconds: MONTH_TTL_SECONDS,
      })
    }
    if (key.budgetTotalUsd !== null) {
      ops.push({ key: totalSpendKey(key.id), kind: 'float', by: cost })
    }
  }

  if (ops.length === 0) return
  try {
    await getUsageStore().apply(ops)
  } catch (err) {
    reportFailure(err)
  }
}

/** Absent headers are honest about a check that did not happen; headers
 * computed from nothing would not be. */
export function rateLimitHeaders(snapshot: LimitSnapshot | null): Record<string, string> {
  if (!snapshot) return {}
  const headers: Record<string, string> = {}
  if (snapshot.rpm) {
    headers['x-ratelimit-limit-requests'] = String(snapshot.rpm.limit)
    headers['x-ratelimit-remaining-requests'] = String(snapshot.rpm.remaining)
    headers['x-ratelimit-reset-requests'] = String(snapshot.rpm.resetSeconds)
  }
  if (snapshot.tpm) {
    headers['x-ratelimit-limit-tokens'] = String(snapshot.tpm.limit)
    headers['x-ratelimit-remaining-tokens'] = String(snapshot.tpm.remaining)
    headers['x-ratelimit-reset-tokens'] = String(snapshot.tpm.resetSeconds)
  }
  return headers
}

/**
 * Reads every listed key's counters in one round trip, for the Keys page.
 *
 * A key with no limits reads as all-null: it has no counters, and showing it
 * a zero would claim it had never been used.
 */
export async function readUsage(
  keys: KeyLimits[],
  now: number = Date.now(),
): Promise<Map<string, UsageReading>> {
  const empty: UsageReading = { rpm: null, tpm: null, monthUsd: null, totalUsd: null }
  const readings = new Map<string, UsageReading>(keys.map((key) => [key.id, { ...empty }]))

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []
  const slots: Array<{ id: string; field: keyof UsageReading; kind: 'window' | 'value' }> = []

  for (const key of keys) {
    if (key.rpmLimit !== null) {
      ops.push({ key: windowKey('rpm', key.id, bucket), kind: 'int', by: 0 })
      ops.push({ key: windowKey('rpm', key.id, bucket - 1), kind: 'int', by: 0 })
      slots.push({ id: key.id, field: 'rpm', kind: 'window' })
    }
    if (key.tpmLimit !== null) {
      ops.push({ key: windowKey('tpm', key.id, bucket), kind: 'int', by: 0 })
      ops.push({ key: windowKey('tpm', key.id, bucket - 1), kind: 'int', by: 0 })
      slots.push({ id: key.id, field: 'tpm', kind: 'window' })
    }
    if (key.budgetMonthlyUsd !== null) {
      ops.push({ key: monthlySpendKey(key.id, now), kind: 'float', by: 0 })
      slots.push({ id: key.id, field: 'monthUsd', kind: 'value' })
    }
    if (key.budgetTotalUsd !== null) {
      ops.push({ key: totalSpendKey(key.id), kind: 'float', by: 0 })
      slots.push({ id: key.id, field: 'totalUsd', kind: 'value' })
    }
  }

  if (ops.length === 0) return readings

  let values: number[]
  try {
    values = await getUsageStore().apply(ops)
  } catch (err) {
    // The page renders em dashes rather than failing; the Governance tab is
    // where an unreachable store gets explained.
    reportFailure(err)
    return readings
  }

  let at = 0
  for (const slot of slots) {
    const reading = readings.get(slot.id)!
    if (slot.kind === 'window') {
      reading[slot.field] = Math.round(estimate(values[at + 1], values[at], now))
      at += 2
    } else {
      reading[slot.field] = values[at]
      at += 1
    }
  }
  return readings
}

/** Forgets a deleted key. The total spend counter has no expiry, so without
 * this it would outlive the key forever. */
export async function clearUsage(keyId: string, now: number = Date.now()): Promise<void> {
  try {
    await getUsageStore().del(allKeysFor(keyId, now))
  } catch (err) {
    reportFailure(err)
  }
}
```

Create `src/lib/usage/index.ts`:

```ts
export * from './limits'
export type { CounterOp, StoreStatus, UsageStore } from './types'
export { getUsageStore, resetUsageStore, usageStoreStatus } from './registry'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/lib/usage/limits.test.ts`
Expected: PASS (13 tests).

If the `rpm is reported before budget` test fails with `insufficient_quota`,
the precedence order in `checkLimits` is wrong — rpm is checked first.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/usage/limits.ts src/lib/usage/index.ts tests/lib/usage/limits.test.ts
git commit -m "feat(usage): limit checks, charges, and rate limit headers"
```

---

### Task 6: Enforce limits in the chat handler

**Files:**
- Modify: `src/lib/gateway/chat-handler.ts`
- Modify: `tests/helpers/gateway.ts` (seed keys with limits)
- Test: `tests/gateway/limits.test.ts`

**Interfaces:**
- Consumes: `checkLimits`, `chargeUsage`, `rateLimitHeaders`,
  `LimitExceededError` from `@/lib/usage` (Task 5).
- Produces: `attemptHeaders(candidate, requestId, dropped?, snapshot?)` — a
  fourth optional `LimitSnapshot | null` argument; `seedGateway({ limits })`
  and `seedTargets({ limits })` in the test helpers.

- [ ] **Step 1: Let the test helpers seed a key with limits**

In `tests/helpers/gateway.ts`, add to `SeedOptions` and `SeedTargetsOptions`:

```ts
/** Limits on the seeded API key. Absent means an unlimited key, which is
 * what every pre-existing test expects. */
limits?: {
  rpmLimit?: number | null
  tpmLimit?: number | null
  budgetMonthlyUsd?: string | null
  budgetTotalUsd?: string | null
}
```

and spread it into both `db.insert(apiKeys).values({...})` calls:

```ts
const [key] = await db.insert(apiKeys).values({
  name: 'test key',
  keyHash: generated.keyHash,
  keyPrefix: generated.keyPrefix,
  ...options.limits,
}).returning()
```

- [ ] **Step 2: Write the failing test**

Create `tests/gateway/limits.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { postgresStore } from '@/lib/logs/postgres'
import { setLoggingSettings } from '@/lib/settings'
import { getUsageStore, resetUsageStore } from '@/lib/usage'
import { bucketOf, totalSpendKey, windowKey } from '@/lib/usage/keys'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { waitFor } from '../helpers/logs'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

const deps = () => fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) })

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  delete process.env.REDIS_URL
  await resetDb()
  await setLoggingSettings({ store: 'postgres' })
  clearRequestLogStoreCache()
  resetUsageStore()
})

test('a key under its limit is served, with rate limit headers', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 10 } })
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(200)
  expect(res.headers.get('x-ratelimit-limit-requests')).toBe('10')
  expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('9')
  expect(Number(res.headers.get('x-ratelimit-reset-requests'))).toBeGreaterThan(0)
})

test('a key with no limits gets no rate limit headers', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(200)
  expect(res.headers.get('x-ratelimit-limit-requests')).toBeNull()
})

test('a key over its rpm limit is rejected with 429 and Retry-After', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(429)
  expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(res.headers.get('x-request-id')).toBeTruthy()
  expect((await res.json()).error).toMatchObject({
    type: 'rate_limit_error', code: 'rate_limit_exceeded',
  })
})

test('the upstream is never called for a rejected request', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())

  const chat = vi.fn().mockResolvedValue(upstreamCompletion)
  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))

  expect(chat).not.toHaveBeenCalled()
})

test('a rejection is not written to the request log', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())
  // The served request's log write is fire-and-forget, so wait for it before
  // asserting on the count — otherwise this passes for the wrong reason.
  await waitFor(async () => (await postgresStore.query({ limit: 10 })).rows.length >= 1)

  await handleChatCompletions(chatRequest(body, apiKey), deps())
  await new Promise((resolve) => setTimeout(resolve, 100))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].status).toBe(200)
})

test('a spent budget is rejected as insufficient_quota', async () => {
  // gpt-4o-mini is unpriced in this seed, so charge the budget directly by
  // giving the key a budget it has already exceeded.
  const { apiKey, key } = await seedGateway({ limits: { budgetTotalUsd: '0.000001' } })
  const store = getUsageStore()
  await store.apply([{ key: totalSpendKey(key.id), kind: 'float', by: 1 }])

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(429)
  expect((await res.json()).error.code).toBe('insufficient_quota')
})

test('a store outage fails open', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  const store = getUsageStore()
  store.apply = async () => { throw new Error('redis is down') }
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const first = await handleChatCompletions(chatRequest(body, apiKey), deps())
  const second = await handleChatCompletions(chatRequest(body, apiKey), deps())

  // Both served: the limit is not enforced while the store is down, which is
  // the deliberate trade. No headers, because no check happened.
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(second.headers.get('x-ratelimit-limit-requests')).toBeNull()
})

test('tokens are charged after the response completes', async () => {
  const { apiKey, key } = await seedGateway({ limits: { tpmLimit: 1000 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())

  const store = getUsageStore()
  const tpmKey = windowKey('tpm', key.id, bucketOf(Date.now()))
  await waitFor(async () => {
    const [tokens] = await store.apply([{ key: tpmKey, kind: 'int', by: 0 }])
    // 5 prompt + 2 completion, charged only once the response is complete.
    return tokens === 7
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run tests/gateway/limits.test.ts`
Expected: FAIL — no headers, no 429s; the first test fails on a null header.

- [ ] **Step 4: Wire the check into the handler**

In `src/lib/gateway/chat-handler.ts`:

Add the import:

```ts
import {
  LimitExceededError, chargeUsage, checkLimits, rateLimitHeaders, type KeyLimits,
  type LimitSnapshot,
} from '@/lib/usage'
```

Extend `attemptHeaders` to carry the snapshot:

```ts
export function attemptHeaders(
  candidate: Candidate,
  requestId: string,
  dropped: string[] = [],
  limits: LimitSnapshot | null = null,
): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
    ...(dropped.length > 0 ? { 'x-babellm-dropped-params': dropped.join(',') } : {}),
    ...rateLimitHeaders(limits),
  }
}
```

Inside `handleChatCompletions`, beside the other request-scoped state:

```ts
  // Held for the charge that happens after the response, and for the headers
  // every response carries.
  let limitedKey: KeyLimits | null = null
  let limits: LimitSnapshot | null = null
```

In `writeLog`, immediately after `cost` is computed, charge from the same
place so pricing is resolved once per request rather than twice:

```ts
    // Charge the key's counters here because this is the one place that has
    // both the measured usage and the priced cost. Never awaited by the
    // response path — writeLog is already fire-and-forget.
    if (limitedKey && usage) {
      void chargeUsage(
        limitedKey,
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
        cost?.totalUsd ?? null,
      )
    }
```

In the `try` block, after `stream = body.stream === true` and **before**
`resolveModel`:

```ts
    // After parsing so a malformed body cannot consume rpm, and before
    // resolving the model so a throttled key does not cost a database lookup
    // — and so a throttled key asking for a model that does not exist still
    // gets the more useful 404 only if it is under its limit.
    limitedKey = apiKey
    limits = await checkLimits(apiKey)
```

Pass `limits` to both `attemptHeaders` call sites:

```ts
      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId, dropped, limits),
```

```ts
    const response = Response.json(completion, {
      headers: attemptHeaders(result.candidate, requestId, dropped, limits),
    })
```

At the top of the `catch` block, before anything else:

```ts
    // Deliberately not logged. A limit rejection never reached a provider,
    // and one log row per rejected request is the traffic pattern that grows
    // fastest exactly when the gateway is under the most stress.
    if (err instanceof LimitExceededError) {
      return errorResponse(err, { 'x-request-id': requestId, ...err.headers })
    }
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `pnpm vitest run tests/gateway/limits.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the whole suite — nothing else may change**

Run: `pnpm test`
Expected: all previous tests still pass. Every pre-existing test seeds a key
with no limits, so none of them should touch the store at all.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/gateway/chat-handler.ts tests/helpers/gateway.ts tests/gateway/limits.test.ts
git commit -m "feat(gateway): enforce per-key rpm, tpm, and budget limits"
```

---

### Task 7: Drop spend_total_usd and clear counters on key deletion

**Files:**
- Modify: `src/lib/db/schema.ts:100-102`
- Create: `drizzle/` migration (generated)
- Modify: `src/lib/admin/keys.ts` (`deleteApiKey`)
- Test: `tests/lib/admin/keys-usage.test.ts`

**Interfaces:**
- Consumes: `clearUsage`, `getUsageStore` from `@/lib/usage` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/admin/keys-usage.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { createApiKey, deleteApiKey } from '@/lib/admin/keys'
import { getUsageStore, resetUsageStore } from '@/lib/usage'
import { totalSpendKey } from '@/lib/usage/keys'
import { waitFor } from '../../helpers/logs'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  delete process.env.REDIS_URL
  await resetDb()
  resetUsageStore()
})

test('deleting a key forgets its counters', async () => {
  const { item } = await createApiKey({ name: 'doomed', budgetTotalUsd: '10' })
  const store = getUsageStore()
  await store.apply([{ key: totalSpendKey(item.id), kind: 'float', by: 4.5 }])

  await deleteApiKey(item.id)

  // The total spend counter is the one with no expiry, so without this it
  // would outlive the key forever.
  await waitFor(async () => {
    const [spend] = await store.apply([{ key: totalSpendKey(item.id), kind: 'float', by: 0 }])
    return spend === 0
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/admin/keys-usage.test.ts`
Expected: FAIL — the counter still reads 4.5 after the delete.

- [ ] **Step 3: Clear counters on delete**

In `src/lib/admin/keys.ts`, add the import and rewrite `deleteApiKey`:

```ts
import { clearUsage } from '@/lib/usage'
```

```ts
export async function deleteApiKey(id: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, id))
  // After the row is gone, and awaited only far enough to start: a counter
  // store that is down must not be able to fail a deletion.
  void clearUsage(id)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/lib/admin/keys-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Drop the dead spend column**

In `src/lib/db/schema.ts`, delete these three lines from `apiKeys`:

```ts
    spendTotalUsd: numeric('spend_total_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
```

Nothing reads or writes it, and nothing will: the store owns spend outright,
so a column showing `0.000000` forever would be a lie the dashboard could
accidentally start telling.

- [ ] **Step 6: Generate and apply the migration**

```bash
pnpm db:generate
```

Inspect the generated file under `drizzle/` — it must contain exactly
`ALTER TABLE "api_keys" DROP COLUMN "spend_total_usd";` and nothing else. If
it contains anything more, stop and investigate before continuing.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`

The global setup migrates the test database, so the new migration is applied
automatically. Expected: all tests pass.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/lib/db/schema.ts src/lib/admin/keys.ts drizzle tests/lib/admin/keys-usage.test.ts
git commit -m "feat(usage): drop spend_total_usd, forget counters on key delete"
```

---

### Task 8: Live usage on the Keys page

**Files:**
- Modify: `src/app/(admin)/keys/page.tsx`
- Test: `tests/lib/usage/read-usage.test.ts`

**Interfaces:**
- Consumes: `readUsage`, `hasLimits`, `UsageReading` from `@/lib/usage`
  (Task 5); `listApiKeys` from `@/lib/admin/keys`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

`readUsage` is already covered for a single key in Task 5; this pins the
batching behaviour the page depends on.

Create `tests/lib/usage/read-usage.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { getUsageStore, readUsage, resetUsageStore } from '@/lib/usage'

beforeEach(() => {
  delete process.env.REDIS_URL
  resetUsageStore()
})

const limited = (id: string) => ({
  id, rpmLimit: 60, tpmLimit: null, budgetMonthlyUsd: '50', budgetTotalUsd: null,
})

test('every key is read in a single round trip', async () => {
  const store = getUsageStore()
  const apply = vi.spyOn(store, 'apply')

  await readUsage([limited('a'), limited('b'), limited('c')])

  // One call, not one per key: the Keys page must cost the same whether an
  // install has three keys or three hundred.
  expect(apply).toHaveBeenCalledTimes(1)
})

test('readings are attributed to the right key', async () => {
  const store = getUsageStore()
  const bucket = Math.floor(Date.now() / 60_000)
  await store.apply([
    { key: `babellm:usage:rpm:a:${bucket}`, kind: 'int', by: 5 },
    { key: `babellm:usage:rpm:b:${bucket}`, kind: 'int', by: 9 },
  ])

  const readings = await readUsage([limited('a'), limited('b')])

  expect(readings.get('a')?.rpm).toBe(5)
  expect(readings.get('b')?.rpm).toBe(9)
  expect(readings.get('a')?.monthUsd).toBe(0)
})

test('keys with no limits are read as null, never zero', async () => {
  const readings = await readUsage([
    { id: 'z', rpmLimit: null, tpmLimit: null, budgetMonthlyUsd: null, budgetTotalUsd: null },
  ])

  // Not counted is not the same as counted and found to be zero.
  expect(readings.get('z')).toEqual({
    rpm: null, tpm: null, monthUsd: null, totalUsd: null,
  })
})
```

- [ ] **Step 2: Run it to verify it passes or fails**

Run: `pnpm vitest run tests/lib/usage/read-usage.test.ts`
Expected: PASS — `readUsage` was built in Task 5. If it fails on the
single-round-trip assertion, `readUsage` is looping per key and must be fixed
to build one op list.

- [ ] **Step 3: Render usage on the Keys page**

In `src/app/(admin)/keys/page.tsx`, add the import:

```ts
import { readUsage, type UsageReading } from '@/lib/usage'
```

Add a formatter beside the existing `limits` one:

```ts
/** What the key has actually used, against what it is allowed. An em dash
 * for a key with no limits: it has no counters, and a 0 would claim it had
 * never been used rather than that nothing was ever counted. */
function usage(reading: UsageReading | undefined) {
  if (!reading) return '—'
  return [
    reading.rpm !== null && `${reading.rpm} rpm`,
    reading.tpm !== null && `${reading.tpm} tpm`,
    reading.monthUsd !== null && `$${reading.monthUsd.toFixed(2)}/mo`,
    reading.totalUsd !== null && `$${reading.totalUsd.toFixed(2)} total`,
  ].filter(Boolean).join(' · ') || '—'
}
```

Read the counters alongside the existing queries:

```ts
  const [keys, users] = await Promise.all([listApiKeys(), listUsers()])
  const readings = await readUsage(keys)
```

Add the column header after `<TableHead>Limits</TableHead>`:

```tsx
            <TableHead>Usage</TableHead>
```

and the cell after the limits cell:

```tsx
              <TableCell className="text-xs text-muted-foreground">
                {usage(readings.get(key.id))}
              </TableCell>
```

Update the empty-state `colSpan={8}` to `colSpan={9}`.

Replace the page description, which currently promises the opposite of what
now happens:

```tsx
        description="Rate limits and budgets are enforced on every request. Counters are held in memory unless REDIS_URL is set, and reset when the gateway restarts."
```

- [ ] **Step 4: Verify in the browser**

Never against port 5432 — use the disposable database:

```bash
pnpm test:db:up
pnpm dev:test-db
```

Open `http://localhost:3001/keys`, create a key with a 60 rpm limit and a $50
monthly budget, and confirm the Usage column reads `0 rpm · $0.00/mo` while a
key with no limits reads `—`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add "src/app/(admin)/keys/page.tsx" tests/lib/usage/read-usage.test.ts
git commit -m "feat(keys): show live rpm and spend against each key's limits"
```

---

### Task 9: Counter store status in the Governance tab

**Files:**
- Create: `src/app/(admin)/settings/usage-status.tsx`
- Modify: `src/app/(admin)/settings/page.tsx`

**Interfaces:**
- Consumes: `usageStoreStatus` from `@/lib/usage` (Task 4).
- Produces: `<UsageStatus />` — a server component taking
  `{ driver: string; healthy: boolean; error: string | null }`.

- [ ] **Step 1: Write the status section**

There is no form here: the driver is an environment variable, and a dropdown
that could not change anything would be worse than a sentence that explains
why.

Create `src/app/(admin)/settings/usage-status.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'

export function UsageStatus({
  driver,
  healthy,
  error,
}: {
  driver: string
  healthy: boolean
  error: string | null
}) {
  return (
    <div className="max-w-xl space-y-2 border-t pt-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Usage counters</span>
        <Badge variant={healthy ? 'default' : 'destructive'}>{driver}</Badge>
      </div>

      {driver === 'redis' ? (
        <p className="text-xs text-muted-foreground">
          Counters live in Redis, so every gateway instance shares one limit.
          They reset if Redis is flushed or is running without persistence —
          a budget is only as durable as the store holding it.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Counters live in this instance&apos;s memory. They reset when the
          gateway restarts, and each instance enforces limits on its own — two
          replicas allow twice the configured rate. Set{' '}
          <span className="font-mono">REDIS_URL</span> to share counters and
          survive restarts.
        </p>
      )}

      {healthy ? null : (
        <p className="text-xs text-destructive">
          Not reachable{error ? `: ${error}` : ''}. Limits are not being
          enforced — requests are served rather than rejected while the store
          is down.
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Render it on the settings page**

In `src/app/(admin)/settings/page.tsx`, add the imports:

```ts
import { usageStoreStatus } from '@/lib/usage'
import { UsageStatus } from './usage-status'
```

and render it inside the governance `TabsContent`, after the `GovernanceForm`
and before the maintenance line:

```tsx
          <UsageStatus {...usageStoreStatus()} />
```

- [ ] **Step 3: Verify in the browser**

```bash
pnpm test:db:up
pnpm dev:test-db
```

Open `http://localhost:3001/settings`. It must show the `memory` badge and the
restart warning. Then stop the server and restart it with a Redis URL to check
the other branch:

```bash
REDIS_URL=redis://localhost:6380 pnpm dev:test-db
```

The badge must read `redis` with the Redis wording. Finally, confirm the
unhealthy branch by pointing at a port with nothing on it:

```bash
REDIS_URL=redis://localhost:6399 pnpm dev:test-db
```

Expected: a `redis` badge in destructive styling and the "Not reachable"
line.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add "src/app/(admin)/settings/usage-status.tsx" "src/app/(admin)/settings/page.tsx"
git commit -m "feat(settings): report the usage counter driver and its health"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Document the optional environment variable**

Append to `.env.example`:

```
# Optional. Where per-key rpm, tpm, and spend counters live. Unset means an
# in-process map: counters reset on restart and each instance enforces limits
# on its own. Set it to share counters across instances.
# REDIS_URL=redis://localhost:6379
```

In `README.md`, add a row to the environment table — under a new "Optional"
heading directly beneath the required table:

```markdown
### Optional

| Variable | Purpose |
|---|---|
| `REDIS_URL` | Where per-key rate limit and spend counters live. Unset means an in-process map — counters reset on restart, and each instance enforces limits independently. |
```

- [ ] **Step 2: Replace the "enforced nowhere" limitation**

In `README.md`, delete this bullet from **Not yet implemented**:

```markdown
- **Rate limits and spend budgets are enforced nowhere.** A key's
  `rpm_limit`, `tpm_limit`, `budget_monthly_usd`, and `budget_total_usd` can
  be set in the dashboard and are stored, but no request is ever rejected
  because of them. **A configured budget is not a spend cap** until Phase 4
  ships budget enforcement — do not treat it as one.
```

and replace it with:

```markdown
- **Spend counters are volatile.** They live in the counter store and nowhere
  else — see [Rate limits and budgets](#rate-limits-and-budgets). Without
  `REDIS_URL`, a restart sets every key's spend back to zero, so
  `budget_total_usd` means "spend since this process started". Budgets survive
  a restart only against a Redis configured to persist.
```

- [ ] **Step 3: Add the feature section**

Add a `## Rate limits and budgets` section to `README.md`, after the
`## Routing` section:

Note the four-backtick wrapper below: the section itself contains a fenced
block, so paste only what is *inside* the outer fence.

````markdown
## Rate limits and budgets

Every API key can carry an `rpm` limit, a `tpm` limit, a monthly budget, and a
total budget. A key that exceeds one is rejected with `429` before the request
reaches a provider. A key with none of them configured is never counted at all
and costs nothing.

Served responses carry the usual headers, so a client can pace itself instead
of discovering the limit by being refused:

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 41
x-ratelimit-reset-requests: 23
```

Rate limits use a sliding window: the current minute in full, plus whatever of
the previous minute has not yet rolled off. A `429` from a rate limit carries
`Retry-After`; one from a total budget does not, because a total budget never
recovers on its own.

**Where the counters live.** In memory by default — per instance, and gone on
restart. Set `REDIS_URL` and every instance shares one set of counters that
survive a restart, provided that Redis persists. The Governance tab reports
which driver is active and whether it is reachable. Redis Cluster and Sentinel
are neither implemented nor tested; `REDIS_URL` names one server.

**When the store is unreachable, the gateway serves the request.** Limits stop
applying for as long as the outage lasts. This is deliberate: a counter store
blip must not become a gateway outage.

Three things this does not do:

- **Reserve ahead.** Tokens and cost are only known after a request finishes,
  so the check is "was this key already over" and the charge comes afterwards.
  A key can exceed a limit by whatever was in flight when it crossed.
- **Log rejections.** A limit rejection never reached a provider, and one row
  per rejected request is the write pattern that would grow fastest exactly
  when the gateway is under the most stress. Throttling shows up in the Keys
  page usage column, not in the request log.
- **Survive a crash mid-rejection.** A rejected request gives back the rpm it
  counted. If the process dies between the two, that key's window reads one
  too high until it expires, up to two minutes later.
````

- [ ] **Step 4: Update the test-database section**

In the `AGENTS.md` note and the README's test instructions, `pnpm test:db:up`
now starts Redis as well. Find the sentence in `README.md` describing what
`pnpm test:db:up` brings up and extend it:

```markdown
That starts the disposable Postgres on 5434 and a disposable Redis on 6380,
both tmpfs-backed and both discarded when the containers stop.
```

- [ ] **Step 5: Verify every claim in the new section**

Read the new README section against the code, not from memory. Specifically
confirm: the header names match `rateLimitHeaders` in
`src/lib/usage/limits.ts`; the total-budget branch really omits
`Retry-After`; and `pnpm test:db:up` really does start both containers
(`docker compose -f docker-compose.test.yml up -d --wait` waits on both
healthchecks).

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example
git commit -m "docs: rate limits, budgets, and where the counters live"
```

---

### Task 11: Full verification

**Files:** none.

- [ ] **Step 1: Run everything from a clean state**

```bash
pnpm test:db:down
pnpm test:db:up
pnpm lint
pnpm typecheck
pnpm test
```

Expected: lint clean, typecheck clean, every test passing — including the
Redis contract suite, which must not be skipped now that the container is up.

- [ ] **Step 2: Confirm the Redis suite actually ran**

```bash
pnpm vitest run tests/lib/usage/redis.test.ts --reporter=verbose
```

Expected: 10 passing tests named `redis: …`. If they are skipped, `.env.test`
is missing `TEST_REDIS_URL` — re-copy it from `.env.test.example`.

- [ ] **Step 3: Prove both drivers enforce the same limit**

```bash
REDIS_URL=redis://localhost:6380 pnpm vitest run tests/gateway/limits.test.ts
```

The handler tests delete `REDIS_URL` in `beforeEach`, so this must still pass
by exercising the memory driver — confirming the suite is not accidentally
dependent on ambient environment. Then verify the Redis path end to end by
hand:

```bash
pnpm dev:test-db   # in one terminal, with REDIS_URL=redis://localhost:6380 prefixed
```

Create a key with `rpm_limit` 2, then:

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:3001/v1/chat/completions \
    -H "authorization: Bearer <key>" -H 'content-type: application/json' \
    -d '{"model":"<your model>","messages":[{"role":"user","content":"hi"}]}'
done
echo
```

Expected: `200 200 429`.

- [ ] **Step 4: Confirm the counters are actually in Redis**

```bash
docker exec -it babellm-test-redis-test-1 redis-cli --scan --pattern 'babellm:usage:*'
```

Expected: the rpm bucket for that key. This is the check that catches a
registry that silently fell back to memory.

- [ ] **Step 5: Report**

Use `superpowers:verification-before-completion` before claiming this is done.
Paste actual command output; do not summarise it.
