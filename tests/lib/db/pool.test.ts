import { afterEach, expect, test, vi } from 'vitest'
import { pool } from '@/lib/db'

// A pooled idle client that errors (Postgres restart, failover,
// idle_session_timeout, PgBouncer recycle) makes pg-pool emit 'error' on the
// Pool. Pool extends EventEmitter, so with no listener Node treats that as
// an unhandled error event and exits the process. We can't genuinely kill a
// pooled connection in a unit test, so this proves the listener exists and
// that emitting a synthetic error is handled rather than thrown.

afterEach(() => {
  vi.restoreAllMocks()
})

test('the pool has an error listener registered', () => {
  expect(pool.listenerCount('error')).toBeGreaterThan(0)
})

test('emitting a synthetic error on the pool does not throw', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => pool.emit('error', new Error('synthetic idle client error'))).not.toThrow()
  expect(consoleError).toHaveBeenCalled()
})
