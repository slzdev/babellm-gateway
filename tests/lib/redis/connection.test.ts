import { afterEach, expect, test } from 'vitest'
import { getRedisConnection, resetRedisConnections } from '@/lib/redis/connection'

const url = process.env.TEST_REDIS_URL

afterEach(() => {
  resetRedisConnections()
})

test.skipIf(!url)('the same url yields the same client', () => {
  const a = getRedisConnection(url!)
  const b = getRedisConnection(url!)
  expect(a.client).toBe(b.client)
})

test.skipIf(!url)('ready() settles and then reports null', async () => {
  const conn = getRedisConnection(url!)
  await conn.ready()
  expect(conn.ready()).toBeNull()
  expect(conn.status()).toEqual({ healthy: true, error: null })
})

test('an unreachable server resolves rather than throwing', async () => {
  // Port 1 has nothing on it. A boot with Redis down must resolve so the
  // caller's fail-open path handles it, never reject into the request path.
  const conn = getRedisConnection('redis://127.0.0.1:1')
  await expect(conn.ready()).resolves.toBeUndefined()
  expect(conn.status().healthy).toBe(false)
})

test.skipIf(!url)(
  'close() only tears down once every holder has released it',
  async () => {
    // The usage store and the target health store both hold the same
    // connection. One store's close() must leave the other's client usable,
    // and only the last release may actually disconnect it.
    const a = getRedisConnection(url!)
    const b = getRedisConnection(url!)
    await a.ready()

    a.close() // one of two holders releases: the client must stay up
    await expect(b.client.ping()).resolves.toBe('PONG')

    b.close() // the last holder releases: now it really tears down
    const c = getRedisConnection(url!)
    expect(c.client).not.toBe(a.client)
  },
)

test.skipIf(!url)(
  'resetRedisConnections() tears down even with holders outstanding',
  async () => {
    const a = getRedisConnection(url!)
    const b = getRedisConnection(url!) // two outstanding holders
    expect(a.client).toBe(b.client)
    await a.ready()

    resetRedisConnections()
    // disconnect() flips `status` on its next tick, not synchronously.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The forced teardown must actually disconnect the shared client, not
    // merely forget it — an orphaned-but-still-connected client would be a
    // real leak (a process.exit-only cleanup) no later holder would ever
    // see, since it's cleared out of the cache too. Checking `status`
    // catches that even though `resetRedisConnections` also unconditionally
    // clears the whole map, which alone can't distinguish "closed" from
    // "merely forgotten".
    expect(a.client.status).toBe('end')

    // And the cache itself no longer serves the old, now-dead client.
    const c = getRedisConnection(url!)
    expect(c.client).not.toBe(a.client)
  },
)
