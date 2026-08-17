import { getRedisConnection } from '@/lib/redis/connection'
import type { CounterOp, StoreStatus, UsageStore } from './types'

export function createRedisStore(url: string): UsageStore {
  const connection = getRedisConnection(url)
  const redis = connection.client

  return {
    name: 'redis',

    async apply(ops: CounterOp[]): Promise<number[]> {
      if (ops.length === 0) return []
      await connection.ready()

      // MULTI, not a plain pipeline: it keeps a counter's INCRBY and its
      // EXPIRE from being separated, so a crash cannot leave a window
      // counter with no expiry. It never needs to branch mid-transaction,
      // which is the only thing a Lua script would have added.
      const tx = redis.multi()
      for (const op of ops) {
        if (op.by === 0) {
          tx.get(op.key)
          continue
        }
        if (op.kind === 'float') tx.incrbyfloat(op.key, op.by)
        else tx.incrby(op.key, op.by)
        if (op.ttlSeconds !== undefined) tx.expire(op.key, op.ttlSeconds)
      }

      const results = await tx.exec()
      if (!results) throw new Error('redis transaction was aborted')

      // Walk the replies in the order the commands were queued, skipping the
      // EXPIRE reply that follows an op that asked for a ttl.
      const values: number[] = []
      let at = 0
      for (const op of ops) {
        const [err, raw] = results[at]
        at += 1
        if (err) throw err
        // A missing counter reads as 0. Unlike prices, a counter genuinely
        // starts at zero — there is no "not measured" state to preserve.
        values.push(raw === null ? 0 : Number(raw))
        if (op.by !== 0 && op.ttlSeconds !== undefined) at += 1
      }
      return values
    },

    async del(keys: string[]): Promise<void> {
      if (keys.length === 0) return
      await connection.ready()
      await redis.del(...keys)
    },

    status(): StoreStatus {
      return connection.status()
    },

    async close(): Promise<void> {
      connection.close()
    },
  }
}
