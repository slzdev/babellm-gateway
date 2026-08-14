import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { initialSealedThrough } from '@/lib/stats/buckets'
import {
  ROLLUP_STATE_KEY, oldestLogHour, readRollupState, writeRollupState,
} from '@/lib/stats/state'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const NOW = new Date('2026-08-14T13:20:00Z')

test('a database with no state starts one unsealed window behind', async () => {
  const state = await readRollupState(NOW)

  expect(state.sealedThrough.toISOString())
    .toBe(initialSealedThrough(NOW).toISOString())
  expect(state.backfilledTo).toBeNull()
  expect(state.oldestLog).toBeNull()
})

test('state round-trips through the settings row', async () => {
  await writeRollupState({
    sealedThrough: new Date('2026-08-14T11:00:00Z'),
    backfilledTo: new Date('2026-08-14T11:00:00Z'),
    oldestLog: new Date('2026-05-01T09:00:00Z'),
  }, NOW)

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(state.backfilledTo?.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(state.oldestLog?.toISOString()).toBe('2026-05-01T09:00:00.000Z')
})

test('writing twice updates the row rather than failing on the primary key', async () => {
  const base = { backfilledTo: null, oldestLog: null }
  await writeRollupState({ ...base, sealedThrough: new Date('2026-08-14T10:00:00Z') }, NOW)
  await writeRollupState({ ...base, sealedThrough: new Date('2026-08-14T11:00:00Z') }, NOW)

  const rows = await db.select().from(settings).where(eq(settings.key, ROLLUP_STATE_KEY))
  expect(rows).toHaveLength(1)
  expect((await readRollupState(NOW)).sealedThrough.toISOString())
    .toBe('2026-08-14T11:00:00.000Z')
})

test('a corrupt state row degrades to the default rather than throwing', async () => {
  // Hand-edited settings must not wedge the job forever.
  await db.insert(settings).values({ key: ROLLUP_STATE_KEY, value: { sealedThrough: 'nonsense' } })

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString())
    .toBe(initialSealedThrough(NOW).toISOString())
})

test('oldestLogHour is null on an empty table', async () => {
  expect(await oldestLogHour()).toBeNull()
})

test('oldestLogHour is the hour of the earliest request', async () => {
  await insertLog({ at: new Date('2026-08-13T09:40:00Z') })
  await insertLog({ at: new Date('2026-08-14T09:40:00Z') })

  expect((await oldestLogHour())?.toISOString()).toBe('2026-08-13T09:00:00.000Z')
})
