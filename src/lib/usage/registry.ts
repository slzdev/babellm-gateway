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
  void store?.close?.().catch((err) => {
    console.error('[gateway] failed to close the usage counter store', err)
  })
  store = null
}

export function usageStoreStatus(): { driver: string } & StoreStatus {
  const resolved = getUsageStore()
  return { driver: resolved.name, ...resolved.status() }
}
