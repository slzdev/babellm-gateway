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
    // The total-spend increment in chargeUsage() relies on exactly this: it
    // never passes a ttlSeconds because that counter must never expire, and
    // this is what guarantees a bare increment cannot accidentally give it one.
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

  test(`${name}: a ttl'd increment does not shift the replies that follow it`, async () => {
    // The exact shape checkLimits() sends: one increment carrying a
    // ttlSeconds (rpmCurrent), followed by by:0 reads of other keys
    // (rpmPrevious, tpm*, spend*). A driver that queues an extra command
    // for the ttl (e.g. a Redis EXPIRE) but forgets to skip its reply when
    // walking results back out desynchronises here — every value after the
    // first would read one op behind.
    const incr = k('shift-incr')
    const readA = k('shift-read-a')
    const readB = k('shift-read-b')
    const readC = k('shift-read-c')

    // Seed the read keys to distinct values first, so a reply shifted by
    // one comes back visibly wrong rather than coincidentally matching.
    await store.apply([
      { key: readA, kind: 'int', by: 11 },
      { key: readB, kind: 'int', by: 22 },
      { key: readC, kind: 'int', by: 33 },
    ])

    const values = await store.apply([
      { key: incr, kind: 'int', by: 1, ttlSeconds: 60 },
      { key: readA, kind: 'int', by: 0 },
      { key: readB, kind: 'int', by: 0 },
      { key: readC, kind: 'int', by: 0 },
    ])

    expect(values).toEqual([1, 11, 22, 33])
  })

  test(`${name}: status reports the driver as usable`, () => {
    expect(store.status()).toEqual({ healthy: true, error: null })
  })
}
