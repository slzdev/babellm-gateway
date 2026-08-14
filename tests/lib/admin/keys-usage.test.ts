import { beforeEach, test } from 'vitest'
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
