import Redis from 'ioredis'
import type { CounterOp, StoreStatus, UsageStore } from './types'

export function createRedisStore(url: string): UsageStore {
  const redis = new Redis(url, {
    // Fail fast rather than queue. With the offline queue on, a command
    // issued while Redis is unreachable waits for reconnection instead of
    // rejecting — which would turn a Redis outage into gateway latency,
    // the exact thing failing open exists to prevent.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    connectTimeout: 1000,
  })

  let lastError: string | null = null

  // ioredis emits 'error' on every failed connection attempt, and an
  // unhandled 'error' event takes the process down. This listener is not
  // optional.
  redis.on('error', (err: Error) => {
    lastError = err.message
  })
  redis.on('ready', () => {
    lastError = null
  })

  // The TCP handshake takes a few milliseconds, and with enableOfflineQueue:
  // false a command issued before it completes rejects immediately instead
  // of waiting. A caller that builds the store and uses it in the same
  // tick — which is exactly what a contract test does, and what a gateway
  // could do at boot if the first request arrives fast enough — would
  // otherwise fail its very first command every time, not just on rare
  // bad luck. This waits once, bounded by connectTimeout, for the first
  // `ready`, and it never rejects: a boot with Redis down must resolve, not
  // throw, so the caller's normal fail-open path handles it from there.
  // Unlike the offline queue, this is one-time and bounded — `firstConnect`
  // is nulled out the instant it settles, so a later live outage after the
  // first connect skips this entirely and fails fast with no added latency,
  // exactly as before.
  let resolveFirstConnect: (() => void) | undefined
  let firstConnect: Promise<void> | null = new Promise((resolve) => {
    resolveFirstConnect = resolve
  })
  const firstConnectTimer = setTimeout(() => {
    firstConnect = null
    resolveFirstConnect?.()
  }, 1000)
  redis.once('ready', () => {
    clearTimeout(firstConnectTimer)
    firstConnect = null
    resolveFirstConnect?.()
  })

  return {
    name: 'redis',

    async apply(ops: CounterOp[]): Promise<number[]> {
      if (ops.length === 0) return []
      if (firstConnect) await firstConnect

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
      if (firstConnect) await firstConnect
      await redis.del(...keys)
    },

    status(): StoreStatus {
      const healthy = redis.status === 'ready' && lastError === null
      // `error` is reserved for an actual failure — the `error` listener
      // above is the only thing that sets `lastError`. Everything else that
      // isn't `ready` (dialing for the first time, reconnecting after a
      // clean close, ...) is "not there yet", not "broken", and must read
      // that way: a caller mid-boot with a healthy Redis would otherwise see
      // the raw ioredis status string (e.g. "connecting") rendered as an
      // error.
      return { healthy, error: healthy ? null : lastError }
    },

    async close(): Promise<void> {
      clearTimeout(firstConnectTimer)
      // If close() runs before `ready` and before the timer fires, nothing
      // else will ever settle `firstConnect`: the timer that would have
      // resolved it is now cancelled, and a disconnected client never emits
      // `ready`. Without this, any apply()/del() already waiting — or
      // issued after — would await forever, which is exactly the unbounded
      // latency this whole mechanism exists to avoid.
      firstConnect = null
      resolveFirstConnect?.()
      redis.disconnect()
    },
  }
}
