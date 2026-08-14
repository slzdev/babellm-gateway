import { beforeEach, expect, test } from 'vitest'
import { pool } from '@/lib/db'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'
import { bucketExpr } from '@/lib/stats/sql'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

/** Runs the expression against a literal uuid, with no table involved. */
async function hourOf(id: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT ${bucketExpr('t')} AS bucket FROM (SELECT $1::uuid AS id) t`,
    [id],
  )
  return (rows[0].bucket as Date).toISOString()
}

test('the expression yields the UTC hour the uuid encodes', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-14T13:37:04.512Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('it agrees with uuidv7Bound at an hour boundary', async () => {
  // uuidv7Bound is what every time-range query in this codebase uses to turn
  // an instant into a primary-key bound. If the two ever disagreed, the job
  // would delete rows for one hour and insert rows for another.
  expect(await hourOf(uuidv7Bound(new Date('2026-08-14T13:00:00Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('the last millisecond of an hour stays in that hour', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-14T13:59:59.999Z'))))
    .toBe('2026-08-14T13:00:00.000Z')
})

test('it truncates in UTC under a fractional-offset session zone', async () => {
  // date_trunc on a timestamptz truncates in the session TimeZone unless a
  // zone is named. Asia/Kolkata is UTC+5:30 (fractional offset). Without the
  // UTC zone argument, local truncation would give 13:30; with it, UTC truncation
  // correctly gives 13:00.
  await pool.query("SET TIME ZONE 'Asia/Kolkata'")
  try {
    expect(await hourOf(uuidv7(new Date('2026-08-14T13:37:04.512Z'))))
      .toBe('2026-08-14T13:00:00.000Z')
  } finally {
    await pool.query('SET TIME ZONE DEFAULT')
  }
})

test('DST transitions do not affect v7 uuid truncation', async () => {
  // A DST boundary exists in Europe/Paris, but v7 ids carry epoch milliseconds,
  // which DST never touches. This test documents that the expression is
  // timezone-agnostic at the semantic level — the zone argument ensures Postgres
  // truncates in UTC regardless of the session setting.
  await pool.query("SET TIME ZONE 'Europe/Paris'")
  try {
    expect(await hourOf(uuidv7(new Date('2026-03-29T01:30:00Z'))))
      .toBe('2026-03-29T01:00:00.000Z')
  } finally {
    await pool.query('SET TIME ZONE DEFAULT')
  }
})

test('it handles a month boundary', async () => {
  expect(await hourOf(uuidv7(new Date('2026-08-31T23:15:00Z'))))
    .toBe('2026-08-31T23:00:00.000Z')
})
