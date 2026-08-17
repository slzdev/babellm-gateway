import { getRedisConnection } from '@/lib/redis/connection'
import { failKey, failTtlSeconds, metaKey, openKey, truncateError } from './keys'
import type { BreakerConfig, HealthStore, StoreStatus, TargetHealth } from './types'

export function createRedisHealthStore(url: string): HealthStore {
  const connection = getRedisConnection(url)
  const redis = connection.client

  return {
    name: 'redis',

    async openTargets(targetIds: string[]): Promise<Set<string>> {
      // MGET with no keys is a Redis error, and a model addressed directly has
      // no breakable targets at all — so this is a real case, not defensive.
      if (targetIds.length === 0) return new Set()
      await connection.ready()

      const values = await redis.mget(...targetIds.map(openKey))
      const open = new Set<string>()
      values.forEach((value, index) => {
        if (value !== null) open.add(targetIds[index])
      })
      return open
    },

    async details(targetIds: string[]): Promise<Map<string, TargetHealth>> {
      if (targetIds.length === 0) return new Map()
      await connection.ready()

      // Three commands per target in one round trip. This is the admin page's
      // read; the request path uses openTargets and never comes here.
      const pipeline = redis.pipeline()
      for (const id of targetIds) {
        pipeline.ttl(openKey(id))
        pipeline.get(failKey(id))
        pipeline.hgetall(metaKey(id))
      }
      const replies = await pipeline.exec()
      if (!replies) throw new Error('redis pipeline was aborted')

      const map = new Map<string, TargetHealth>()
      targetIds.forEach((id, index) => {
        const [ttlErr, ttlRaw] = replies[index * 3]
        const [failErr, failRaw] = replies[index * 3 + 1]
        const [metaErr, metaRaw] = replies[index * 3 + 2]
        if (ttlErr || failErr || metaErr) throw (ttlErr ?? failErr ?? metaErr)

        // TTL answers -2 for a missing key and -1 for one with no expiry.
        // Only a non-negative number means "open, with this long to run".
        const ttl = Number(ttlRaw)
        const failures = failRaw === null ? 0 : Number(failRaw)
        const meta = (metaRaw ?? {}) as Record<string, string>

        // Absence of every key is health, not an entry saying so.
        if (ttl < 0 && failures === 0) return

        map.set(id, {
          open: ttl >= 0,
          reopensIn: ttl >= 0 ? ttl : null,
          consecutiveFailures: failures,
          openedAt: meta.openedAt ? Number(meta.openedAt) : null,
          lastError: meta.lastError ?? null,
        })
      })
      return map
    },

    async fail(targetId: string, config: BreakerConfig, error: string): Promise<void> {
      if (config.threshold <= 0) return
      await connection.ready()

      const ttl = failTtlSeconds(config.cooldownSeconds)
      // MULTI, not a plain pipeline: it keeps the INCR and its EXPIRE from
      // being separated, so a crash cannot leave a counter with no expiry —
      // which would be a breaker that never forgets.
      const replies = await redis.multi().incr(failKey(targetId)).expire(failKey(targetId), ttl).exec()
      if (!replies) throw new Error('redis transaction was aborted')
      const [incrErr, incrRaw] = replies[0]
      const [expireErr] = replies[1]
      if (incrErr) throw incrErr
      if (expireErr) throw expireErr

      if (Number(incrRaw) < config.threshold) return

      // Crossing the threshold. Two instances can arrive here together; both
      // SET, the write is idempotent, and the second merely refreshes the TTL.
      // Locking would buy nothing.
      const now = Date.now()
      const opened = await redis
        .multi()
        .set(openKey(targetId), '1', 'EX', config.cooldownSeconds)
        .hset(metaKey(targetId), { openedAt: String(now), lastError: truncateError(error) })
        // The meta hash is only ever read alongside a live counter, so it
        // expires on the counter's schedule rather than growing forever.
        .expire(metaKey(targetId), ttl)
        .exec()
      if (!opened) throw new Error('redis transaction was aborted')
      for (const [err] of opened) {
        if (err) throw err
      }
    },

    async succeed(targetId: string): Promise<void> {
      await connection.ready()
      // Drops the meta hash too, not just open+fail: otherwise a later
      // sub-threshold failure would report this resolved incident's
      // openedAt/lastError as if it were live. Matches the memory driver,
      // which drops the whole entry on success.
      await redis.del(openKey(targetId), failKey(targetId), metaKey(targetId))
    },

    async reset(targetId: string): Promise<void> {
      await connection.ready()
      await redis.del(openKey(targetId), failKey(targetId), metaKey(targetId))
    },

    status(): StoreStatus {
      return connection.status()
    },

    async close(): Promise<void> {
      connection.close()
    },
  }
}
