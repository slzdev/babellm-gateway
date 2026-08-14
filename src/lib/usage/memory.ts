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
