import { beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { PRUNE_LOCK_KEY, pruneRequestLogs } from '@/lib/logs/retention'
import { setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../../helpers/db'

const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

async function writeOne(requestId: string) {
  await postgresStore.write({
    requestId, keyId: null, keyName: null, model: 'm',
    stream: false, status: 200, outcome: 'ok', latencyMs: 1, attempts: [],
  })
}

test('deletes rows older than the retention window', async () => {
  await writeOne('old')
  // Rows are pruned by their v7 id, so "now" moving forward is what makes the
  // existing row old.
  const later = new Date(Date.now() + 31 * DAY)

  expect(await pruneRequestLogs(later)).toBe(1)
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)
})

test('keeps rows inside the window', async () => {
  await writeOne('fresh')
  expect(await pruneRequestLogs(new Date())).toBe(0)
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
})

test('zero retention disables pruning entirely', async () => {
  await setLoggingSettings({ retentionDays: 0 })
  clearRequestLogStoreCache()
  await writeOne('kept')

  expect(await pruneRequestLogs(new Date(Date.now() + 400 * DAY))).toBeNull()
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
})

test('prunes data in a non-active store rather than only the currently-configured one', async () => {
  // request_logs/request_payloads hold captured prompt and completion
  // content. Switching the active store to stdout must not leave that data
  // unpruned forever just because reads no longer go through postgres.
  await writeOne('old')
  await setLoggingSettings({ store: 'stdout' })
  clearRequestLogStoreCache()

  const later = new Date(Date.now() + 31 * DAY)
  expect(await pruneRequestLogs(later)).toBe(1)
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)
})

test('skips the run when another instance holds the lock', async () => {
  await writeOne('old')
  const holder = await db.$client.connect()
  await holder.query('SELECT pg_advisory_lock($1)', [PRUNE_LOCK_KEY.toString()])

  try {
    expect(await pruneRequestLogs(new Date(Date.now() + 31 * DAY))).toBeNull()
    expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(1)
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [PRUNE_LOCK_KEY.toString()])
    holder.release()
  }
})

test('records when it last ran', async () => {
  await writeOne('old')
  await pruneRequestLogs(new Date(Date.now() + 31 * DAY))

  const rows = await db.execute(sql`SELECT value FROM settings WHERE key = 'logs.last_prune'`)
  expect(rows.rowCount).toBe(1)
})

test('pins the advisory lock and its unlock to one connection', async () => {
  // pg_try_advisory_lock/pg_advisory_unlock are scoped to the session that
  // issued them. This does not prove cross-process exclusion — the "skips
  // the run" test above already covers that — it proves the specific
  // regression from fix round 1: that the lock and its unlock are issued on
  // one client checked out with pool.connect(), rather than as two
  // independent db.execute() calls that could each land on a different
  // pooled connection.
  //
  // pool.connect is also invoked internally, in its callback form, by every
  // pool.query() — which is what db.execute()/drizzle use for
  // resolveRequestLogStore's settings read, store.prune's DELETEs, and the
  // last_prune upsert. Those must pass straight through undisturbed, or the
  // test hangs waiting on a callback the mock swallowed. Only the explicit,
  // no-argument, promise-returning call that pruneRequestLogs itself makes
  // is instrumented — that is the one this test cares about.
  await writeOne('old')

  const queries: string[] = []
  let explicitConnects = 0
  let querySpy: ReturnType<typeof vi.spyOn> | undefined
  const originalConnect = pool.connect.bind(pool)
  const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(((cb?: unknown) => {
    if (typeof cb === 'function') {
      // Passthrough for pool.query()'s internal callback-style connects.
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
    expect(await pruneRequestLogs(new Date(Date.now() + 31 * DAY))).toBe(1)
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
