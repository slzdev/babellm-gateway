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
