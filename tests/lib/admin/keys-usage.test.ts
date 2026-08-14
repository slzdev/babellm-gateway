import { beforeEach, expect, test, vi } from 'vitest'
import { createApiKey, deleteApiKey, listApiKeys, resetApiKeyUsage } from '@/lib/admin/keys'
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

test('resetting a key\'s usage clears its counters and keeps the key', async () => {
  const { item } = await createApiKey({ name: 'spent', budgetTotalUsd: '10' })
  const store = getUsageStore()
  await store.apply([{ key: totalSpendKey(item.id), kind: 'float', by: 9.75 }])

  // Total spend never expires, so raising the budget is otherwise the only
  // way to get a key that hit it working again.
  expect(await resetApiKeyUsage(item.id)).toBe(true)

  const [spend] = await store.apply([{ key: totalSpendKey(item.id), kind: 'float', by: 0 }])
  expect(spend).toBe(0)
  expect(await listApiKeys()).toHaveLength(1)
})

test('resetting usage reports a store outage rather than claiming success', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { item } = await createApiKey({ name: 'spent' })
  getUsageStore().del = async () => { throw new Error('redis is down') }

  expect(await resetApiKeyUsage(item.id)).toBe(false)
  spy.mockRestore()
})

test('resetting the usage of a key that no longer exists reports it', async () => {
  await expect(
    resetApiKeyUsage('00000000-0000-0000-0000-000000000000'),
  ).rejects.toThrow(/not found/i)
})
