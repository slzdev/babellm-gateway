import { afterEach, beforeEach, expect, test, vi } from 'vitest'
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

/** A store-failure test deliberately triggers `reportFailure`'s
 * `console.error`. Silencing it locally keeps that expected-but-noisy line
 * out of the suite's output without hiding a genuinely unexpected one from
 * any other test. */
function silenceErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
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

test('a monthly budget rejects at exactly the limit, not only past it', async () => {
  // rpm and total budget are both pinned by an exact-limit test elsewhere;
  // monthly was the one member of the >= family left untested at its
  // boundary — 0.02 against 0.01 above passes under > just as well as >=.
  const k = key({ budgetMonthlyUsd: '0.01' })
  await chargeUsage(k, 0, '0.01')
  const err = await rejection(k)

  expect(err.code).toBe('insufficient_quota')
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

test('a key with all four limits compares each counter against the right one', async () => {
  // No other test sets more than one window limit (rpm and tpm together) or
  // both budgets together, so tpmCurrent/tpmPrevious are otherwise only ever
  // read at indices 0 and 1 — the case where rpm is absent. If the op-index
  // bookkeeping mis-indexed tpm by two slots (reading rpm's counters
  // instead), this key would never see a tpm rejection: it would keep
  // comparing rpm's own count (well under its limit of 5) against the tpm
  // limit, and this test would fail with "expected to reject, but it
  // allowed the request" rather than with a wrong message.
  const k = key({
    rpmLimit: 5, tpmLimit: 100, budgetMonthlyUsd: '10', budgetTotalUsd: '100',
  })
  await checkLimits(k)
  await chargeUsage(k, 100, null)

  const err = await rejection(k)
  expect(err.code).toBe('rate_limit_exceeded')
  // Asserting on the message, not just the code, is what pins the index:
  // a mis-indexed rpm/tpm read could still produce a rate_limit_exceeded
  // rejection for the wrong reason.
  expect(err.message).toContain('100 tokens per minute')
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

test('readUsage reads several keys with different limit shapes in one round trip', async () => {
  // No other test calls readUsage with more than one key, so the slot walk
  // that maps each key's ops back to its own reading — and the "exactly one
  // round trip regardless of key count" contract — was unverifiable.
  const windowOnly = key({ id: 'key-window', rpmLimit: 5 })
  const valueOnly = key({ id: 'key-value', budgetTotalUsd: '10' })
  const mixed = key({ id: 'key-mixed', rpmLimit: 3, budgetMonthlyUsd: '5' })

  await checkLimits(windowOnly) // rpm -> 1
  await chargeUsage(valueOnly, 0, '2.50') // totalUsd -> 2.50
  await checkLimits(mixed) // rpm -> 1
  await checkLimits(mixed) // rpm -> 2
  await chargeUsage(mixed, 0, '1.00') // monthUsd -> 1.00

  const store = (await import('@/lib/usage/registry')).getUsageStore()
  const original = store.apply.bind(store)
  let calls = 0
  store.apply = async (ops) => {
    calls += 1
    return original(ops)
  }

  const readings = await readUsage([windowOnly, valueOnly, mixed])

  expect(calls).toBe(1)
  expect(readings.get('key-window')).toEqual({ rpm: 1, tpm: null, monthUsd: null, totalUsd: null })
  expect(readings.get('key-value')).toEqual({ rpm: null, tpm: null, monthUsd: null, totalUsd: 2.5 })
  expect(readings.get('key-mixed')).toEqual({ rpm: 2, tpm: null, monthUsd: 1, totalUsd: null })
})

test('a store failure fails open and emits no headers', async () => {
  const spy = silenceErrors()
  const k = key({ rpmLimit: 1 })
  const store = (await import('@/lib/usage/registry')).getUsageStore()
  store.apply = async () => { throw new Error('redis is down') }

  // No throw, no opinion: a counter store outage must not become a gateway
  // outage.
  expect(await checkLimits(k)).toBeNull()
  expect(rateLimitHeaders(null)).toEqual({})
  spy.mockRestore()
})

test('chargeUsage never throws when the store fails', async () => {
  const spy = silenceErrors()
  const k = key({ tpmLimit: 100 })
  const store = (await import('@/lib/usage/registry')).getUsageStore()
  store.apply = async () => { throw new Error('redis is down') }

  // This runs after the response has already been sent — a rejection here
  // would be an unhandled rejection in production, not a request failure.
  await expect(chargeUsage(k, 10, '0.01')).resolves.toBeUndefined()
  spy.mockRestore()
})

test('clearUsage reports a store failure instead of throwing', async () => {
  const spy = silenceErrors()
  const store = (await import('@/lib/usage/registry')).getUsageStore()
  store.del = async () => { throw new Error('redis is down') }

  // False rather than a throw: a caller deleting a key must not fail over a
  // counter store outage, but one that told an admin "counters reset" needs
  // to know it did not happen.
  await expect(clearUsage('key-1')).resolves.toBe(false)
  spy.mockRestore()
})

test('clearUsage reports success when the counters are gone', async () => {
  await expect(clearUsage('key-1')).resolves.toBe(true)
})

test('clearUsage forgets a deleted key', async () => {
  const k = key({ rpmLimit: 10, budgetTotalUsd: '1' })
  await checkLimits(k)
  await chargeUsage(k, 0, '0.5')

  await clearUsage('key-1')

  const reading = (await readUsage([k])).get('key-1')
  expect(reading).toEqual({ rpm: 0, tpm: null, monthUsd: null, totalUsd: 0 })
})
