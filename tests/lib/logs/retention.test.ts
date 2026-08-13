import { beforeEach, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
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
