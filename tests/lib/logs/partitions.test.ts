import { beforeEach, expect, test } from 'vitest'
import { pool } from '@/lib/db'
import { uuidv7Bound } from '@/lib/uuid'
import {
  addMonths, dropExpiredPartitions, ensurePartitions, monthBound, monthStart, partitionName,
} from '@/lib/logs/partitions'
import { resetDb } from '../../helpers/db'

const utc = (iso: string) => new Date(iso)

beforeEach(resetDb)

test('monthStart truncates to the first instant of the UTC month', () => {
  expect(monthStart(utc('2026-08-13T21:47:03.123Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('monthStart uses UTC, not the local zone', () => {
  // 23:30 on 31 July in UTC is already August in any zone east of Greenwich.
  // Reading the local month here would file the row a month early on half the
  // planet's servers and leave the two halves disagreeing about which
  // partition a row belongs to.
  expect(monthStart(utc('2026-07-31T23:30:00Z')).toISOString())
    .toBe('2026-07-01T00:00:00.000Z')
})

test('addMonths rolls the year over in both directions', () => {
  expect(addMonths(utc('2026-12-01T00:00:00Z'), 1).toISOString())
    .toBe('2027-01-01T00:00:00.000Z')
  expect(addMonths(utc('2026-01-01T00:00:00Z'), -1).toISOString())
    .toBe('2025-12-01T00:00:00.000Z')
})

test('addMonths does not overflow from a long month into the wrong one', () => {
  // Date.setMonth on 31 January + 1 month yields 3 March, because 31 February
  // does not exist. Partition bounds are always month starts, but the helper
  // must not be a trap for a caller that passes anything else.
  expect(addMonths(utc('2026-01-31T00:00:00Z'), 1).toISOString())
    .toBe('2026-02-01T00:00:00.000Z')
})

test('partitionName zero-pads the month', () => {
  expect(partitionName(utc('2026-08-13T00:00:00Z'))).toBe('request_logs_2026_08')
  expect(partitionName(utc('2026-11-02T00:00:00Z'))).toBe('request_logs_2026_11')
})

test('monthBound agrees with uuidv7Bound at the month start', () => {
  expect(monthBound(utc('2026-08-13T09:00:00Z')))
    .toBe(uuidv7Bound(utc('2026-08-01T00:00:00Z')))
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

test('ensurePartitions creates the current month and three ahead', async () => {
  await ensurePartitions(pool, utc('2030-03-15T00:00:00Z'))

  expect(await partitions()).toEqual(expect.arrayContaining([
    'request_logs_2030_03', 'request_logs_2030_04',
    'request_logs_2030_05', 'request_logs_2030_06',
  ]))
})

test('ensurePartitions is idempotent and reports only what it created', async () => {
  const first = await ensurePartitions(pool, utc('2031-11-02T00:00:00Z'))
  expect(first).toHaveLength(4)
  // Crosses a year boundary: November plus three is February of the next year.
  expect(first).toContain('request_logs_2032_02')

  const second = await ensurePartitions(pool, utc('2031-11-02T00:00:00Z'))
  expect(second).toEqual([])
})

test('a row routes to the partition its id encodes', async () => {
  await ensurePartitions(pool, utc('2030-03-15T00:00:00Z'))
  const id = monthBound(utc('2030-04-09T00:00:00Z'))

  await pool.query(`
    INSERT INTO request_logs (id, status, outcome, latency_ms)
    VALUES ('${id}', 200, 'ok', 1)
  `)
  const { rows } = await pool.query(
    `SELECT tableoid::regclass::text AS partition FROM request_logs WHERE id = '${id}'`,
  )
  expect(rows[0].partition).toBe('request_logs_2030_04')
})

test('a write with no partition for its month fails rather than going anywhere else', async () => {
  // The cost of having no DEFAULT partition, asserted rather than assumed:
  // the failure is loud and local, not a row quietly parked outside retention.
  const id = monthBound(utc('2040-01-05T00:00:00Z'))
  await expect(pool.query(`
    INSERT INTO request_logs (id, status, outcome, latency_ms)
    VALUES ('${id}', 200, 'ok', 1)
  `)).rejects.toThrow(/no partition of relation/i)
})

test('dropExpiredPartitions keeps the current month and N-1 before it', async () => {
  const now = utc('2030-06-15T00:00:00Z')
  await ensurePartitions(pool, utc('2030-01-15T00:00:00Z'))
  await ensurePartitions(pool, now)

  const dropped = await dropExpiredPartitions(pool, now, 3)

  // Scoped to the months this test created. The fixture also seeds the real
  // current month and its lead, which are years older than this test's `now`
  // and are therefore swept as well. Asserting the whole list would be
  // asserting what the fixture happens to contain rather than what the
  // function under test decides.
  expect(dropped.filter((name) => name.startsWith('request_logs_2030_'))).toEqual([
    'request_logs_2030_01', 'request_logs_2030_02', 'request_logs_2030_03',
  ])
  const left = await partitions()
  expect(left).toContain('request_logs_2030_04')
  expect(left).toContain('request_logs_2030_06')
  expect(left).not.toContain('request_logs_2030_03')
})

test('dropExpiredPartitions never drops a future partition', async () => {
  const now = utc('2030-06-15T00:00:00Z')
  await ensurePartitions(pool, now)

  await dropExpiredPartitions(pool, now, 1)

  expect(await partitions()).toEqual(expect.arrayContaining([
    'request_logs_2030_06', 'request_logs_2030_07',
    'request_logs_2030_08', 'request_logs_2030_09',
  ]))
})

test('zero retention drops nothing', async () => {
  await ensurePartitions(pool, utc('2029-01-15T00:00:00Z'))
  expect(await dropExpiredPartitions(pool, utc('2030-06-15T00:00:00Z'), 0)).toEqual([])
  expect(await partitions()).toContain('request_logs_2029_01')
})

test('a partition whose name does not parse is left alone', async () => {
  // The catalog is enumerated rather than a computed list of names deleted,
  // so anything hand-made is visible here. Visible is not the same as owned:
  // dropping a table this module did not create would be the worst possible
  // reading of "retention".
  await ensurePartitions(pool, utc('2030-06-15T00:00:00Z'))
  await pool.query(`
    CREATE TABLE request_logs_archive PARTITION OF request_logs
    FOR VALUES FROM ('${monthBound(utc('2020-01-01T00:00:00Z'))}')
                 TO ('${monthBound(utc('2020-02-01T00:00:00Z'))}')
  `)

  const dropped = await dropExpiredPartitions(pool, utc('2030-06-15T00:00:00Z'), 1)

  expect(dropped).not.toContain('request_logs_archive')
  expect(await partitions()).toContain('request_logs_archive')
  await pool.query('DROP TABLE request_logs_archive')
})
