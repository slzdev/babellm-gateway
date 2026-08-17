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
