import Redis from 'ioredis'

export interface RedisConnection {
  readonly client: Redis
  ready(): Promise<void> | null
  status(): { healthy: boolean; error: string | null }
  close(): void
}

interface CachedConnection extends RedisConnection {
  /**
   * Refcount of holders sharing this connection. The usage counter store
   * and the target health store both call getRedisConnection() with the
   * same url and get back the same client — one store's close() must not
   * pull the client out from under the other, so the client is only
   * actually disconnected once every holder has released it.
   */
  holders: number
}

const connections = new Map<string, CachedConnection>()

/**
 * One client per URL, shared by every store that needs Redis.
 *
 * Shared rather than one client per store because this bootstrap is subtle —
 * see the three comments below — and a second hand-copied version of it would
 * be a second place for the same bug to be fixed only once.
 */
export function getRedisConnection(url: string): RedisConnection {
  const existing = connections.get(url)
  if (existing) {
    existing.holders += 1
    return existing
  }

  const client = new Redis(url, {
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
  client.on('error', (err: Error) => {
    lastError = err.message
  })
  client.on('ready', () => {
    lastError = null
  })

  // The TCP handshake takes a few milliseconds, and with enableOfflineQueue:
  // false a command issued before it completes rejects immediately instead
  // of waiting. A caller that builds a store and uses it in the same tick —
  // which is exactly what a contract test does, and what a gateway could do
  // at boot if the first request arrives fast enough — would otherwise fail
  // its very first command every time, not just on rare bad luck. This waits
  // once, bounded by connectTimeout, for the first `ready`, and it never
  // rejects: a boot with Redis down must resolve, not throw, so the caller's
  // normal fail-open path handles it from there. Unlike the offline queue,
  // this is one-time and bounded — `firstConnect` is nulled out the instant
  // it settles, so a later live outage after the first connect skips this
  // entirely and fails fast with no added latency.
  let resolveFirstConnect: (() => void) | undefined
  let firstConnect: Promise<void> | null = new Promise((resolve) => {
    resolveFirstConnect = resolve
  })
  const timer = setTimeout(() => {
    firstConnect = null
    resolveFirstConnect?.()
  }, 1000)
  client.once('ready', () => {
    clearTimeout(timer)
    firstConnect = null
    resolveFirstConnect?.()
  })

  const connection: CachedConnection = {
    client,
    holders: 1,
    ready: () => firstConnect,
    status() {
      const healthy = client.status === 'ready' && lastError === null
      // `error` is reserved for an actual failure — the `error` listener
      // above is the only thing that sets `lastError`. Everything else that
      // isn't `ready` (dialing for the first time, reconnecting after a
      // clean close, ...) is "not there yet", not "broken", and must read
      // that way: a caller mid-boot with a healthy Redis would otherwise see
      // the raw ioredis status string (e.g. "connecting") rendered as an
      // error.
      return { healthy, error: healthy ? null : lastError }
    },
    close() {
      // Only the last holder to let go actually tears the client down —
      // see the `holders` doc comment above.
      connection.holders -= 1
      if (connection.holders > 0) return

      clearTimeout(timer)
      // If close() runs before `ready` and before the timer fires, nothing
      // else will ever settle `firstConnect`: the timer that would have
      // resolved it is now cancelled, and a disconnected client never emits
      // `ready`. Without this, any command already waiting — or issued
      // after — would await forever, which is exactly the unbounded latency
      // this whole mechanism exists to avoid.
      firstConnect = null
      resolveFirstConnect?.()
      connections.delete(url)
      client.disconnect()
    },
  }

  connections.set(url, connection)
  return connection
}

/** Tests only. Drops every cached connection, regardless of holder count. */
export function resetRedisConnections(): void {
  for (const connection of [...connections.values()]) {
    connection.holders = 1
    connection.close()
  }
  connections.clear()
}
