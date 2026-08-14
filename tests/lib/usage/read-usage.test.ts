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
