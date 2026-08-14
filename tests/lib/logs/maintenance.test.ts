import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { PARTITION_LOCK_KEY, runLogMaintenance } from '@/lib/logs/maintenance'
import * as settingsModule from '@/lib/settings'
import { setLoggingSettings } from '@/lib/settings'
import { WRITE_ONLY_DRIVER, registerWriteOnlyDriver } from '../../helpers/logs'
import { resetDb } from '../../helpers/db'

let unregister: (() => void) | null = null

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  unregister?.()
  unregister = null
})

async function partitions(): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs'
    ORDER BY c.relname
  `)
  return rows.map((row) => String(row.name))
}

test('provisions the months ahead of now', async () => {
  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.created).toEqual(expect.arrayContaining([
    'request_logs_2030_06', 'request_logs_2030_07',
    'request_logs_2030_08', 'request_logs_2030_09',
  ]))
})

test('drops months that fell outside the retention window', async () => {
  await setLoggingSettings({ retentionMonths: 2 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2030-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toContain('request_logs_2030_01')
  expect(await partitions()).not.toContain('request_logs_2030_01')
})

test('zero retention still provisions but drops nothing', async () => {
  await setLoggingSettings({ retentionMonths: 0 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2029-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toEqual([])
  expect(result?.created).toContain('request_logs_2030_06')
  expect(await partitions()).toContain('request_logs_2029_01')
})

test('a failed settings read provisions but does not drop, rather than dropping against a guessed retention', async () => {
  // An operator set retentionMonths: 12 because these rows hold captured
  // prompts and completions they are required to keep. A settings read that
  // fails mid-run must not fall back to guessing 3 and dropping nine months
  // of partitions on that guess — DROP TABLE has no undo.
  await setLoggingSettings({ retentionMonths: 12 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2030-01-15T00:00:00Z'))

  clearRequestLogStoreCache()
  vi.spyOn(settingsModule, 'getLoggingSettings').mockRejectedValueOnce(new Error('settings read failed'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toEqual([])
  expect(result?.created).toContain('request_logs_2030_06')
  expect(await partitions()).toContain('request_logs_2030_01')
})

test('maintains a non-active store rather than only the configured one', async () => {
  // request_logs holds captured prompt and completion content. Switching the
  // active store to another driver must not leave that data unpruned forever
  // just because reads no longer go through postgres.
  unregister = registerWriteOnlyDriver()
  await setLoggingSettings({ store: WRITE_ONLY_DRIVER, retentionMonths: 2 })
  clearRequestLogStoreCache()
  await runLogMaintenance(new Date('2030-01-15T00:00:00Z'))

  const result = await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  expect(result?.dropped).toContain('request_logs_2030_01')
})

test('skips the run when another instance holds the lock', async () => {
  const holder = await pool.connect()
  await holder.query('SELECT pg_advisory_lock($1)', [PARTITION_LOCK_KEY.toString()])

  try {
    expect(await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))).toBeNull()
    expect(await partitions()).not.toContain('request_logs_2030_06')
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [PARTITION_LOCK_KEY.toString()])
    holder.release()
  }
})

test('releases the lock so the next run proceeds', async () => {
  await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))
  expect(await runLogMaintenance(new Date('2030-07-15T00:00:00Z'))).not.toBeNull()
})

test('records when it last ran and what it did', async () => {
  await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))

  const rows = await db.execute(
    sql`SELECT value FROM settings WHERE key = 'logs.last_maintenance'`,
  )
  expect(rows.rowCount).toBe(1)
  const value = rows.rows[0].value as { at: string; created: string[]; dropped: string[] }
  expect(value.created).toContain('request_logs_2030_06')
  expect(Array.isArray(value.dropped)).toBe(true)
  expect(typeof value.at).toBe('string')
})

test('pins the advisory lock and its unlock to one connection', async () => {
  // pg_try_advisory_lock/pg_advisory_unlock are scoped to the session that
  // issued them. This does not prove cross-process exclusion — the "skips the
  // run" test above covers that — it proves the lock and its unlock are
  // issued on one client checked out with pool.connect(), rather than as two
  // independent db.execute() calls that could each land on a different pooled
  // connection, leaking the lock on the one that took it.
  //
  // pool.connect is also invoked internally, in its callback form, by every
  // pool.query() — which is what the settings read, the DDL, and the
  // last_maintenance upsert all use. Those must pass through undisturbed or
  // the test hangs on a callback the mock swallowed. Only the explicit,
  // no-argument, promise-returning call that runLogMaintenance itself makes
  // is instrumented.
  const queries: string[] = []
  let explicitConnects = 0
  let querySpy: ReturnType<typeof vi.spyOn> | undefined
  const originalConnect = pool.connect.bind(pool)
  const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(((cb?: unknown) => {
    if (typeof cb === 'function') {
      return (originalConnect as unknown as (cb: unknown) => void)(cb)
    }

    explicitConnects += 1
    return (async () => {
      const client = await originalConnect()
      const originalQuery = client.query.bind(client)
      querySpy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
        queries.push(String(args[0]))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalQuery as any)(...args)
      }) as typeof client.query)
      return client
    })()
  }) as typeof pool.connect)

  try {
    expect(await runLogMaintenance(new Date('2030-06-15T00:00:00Z'))).not.toBeNull()
  } finally {
    connectSpy.mockRestore()
    querySpy?.mockRestore()
  }

  expect(explicitConnects).toBe(1)
  const lockIndex = queries.findIndex((q) => q.includes('pg_try_advisory_lock'))
  const unlockIndex = queries.findIndex((q) => q.includes('pg_advisory_unlock'))
  expect(lockIndex).toBeGreaterThanOrEqual(0)
  expect(unlockIndex).toBeGreaterThan(lockIndex)
})
