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

  test(`${name}: success forgets the resolved incident, not just the counter`, async () => {
    const id = k('success-then-below')
    await store.fail(id, config, 'first incident')
    await store.fail(id, config, 'first incident')
    expect(await store.openTargets([id])).toEqual(new Set([id]))

    await store.succeed(id)

    // A later failure that stays below threshold must not resurrect the
    // resolved incident's openedAt/lastError — that would be a driver
    // reporting a target as having last failed for a reason it already
    // recovered from.
    await store.fail(id, config, 'unrelated later blip')
    const health = (await store.details([id])).get(id)
    expect(health?.open).toBe(false)
    expect(health?.consecutiveFailures).toBe(1)
    expect(health?.openedAt).toBeNull()
    expect(health?.lastError).toBeNull()
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
