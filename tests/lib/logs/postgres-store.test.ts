import { eq, sql } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { db, pool } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { postgresStore } from '@/lib/logs/postgres'
import { ensurePartitions } from '@/lib/logs/partitions'
import { uuidv7 } from '@/lib/uuid'
import type { RequestLogEntry } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(),
    keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('a written entry comes back from query under the id it was given', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, model: 'house-model' }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ id, model: 'house-model', status: 200 })
})

test('get returns the attempt chain and the payload', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({
    id,
    attempts: [
      { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
      { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
    ],
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }))

  const detail = await postgresStore.get(id)
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0].error).toBe('down')
  expect(detail?.payloadCaptured).toBe(true)
  expect(detail?.payload?.request).toEqual({ model: 'house-model' })
  expect(detail?.payload?.truncated).toBe(false)
})

test('get returns null for an unknown id', async () => {
  expect(await postgresStore.get(uuidv7())).toBeNull()
})

test('get returns null rather than throwing for a malformed id', async () => {
  // A hand-edited URL reaches this with anything at all. Without the guard the
  // string reaches a uuid column comparison and Postgres raises "invalid input
  // syntax for type uuid" — a 500 where a 404 belongs.
  expect(await postgresStore.get('not-a-uuid')).toBeNull()
  expect(await postgresStore.get('')).toBeNull()
  expect(await postgresStore.get("'; DROP TABLE request_logs; --")).toBeNull()
})

test('an entry without a payload records payload_captured false', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id }))
  const detail = await postgresStore.get(id)
  expect(detail?.payloadCaptured).toBe(false)
  expect(detail?.payload).toBeNull()
})

test('get trusts the payload columns over the flag, not the other way around', async () => {
  // write() cannot produce this divergence — it sets the flag and the
  // columns from the same value — so it is inserted through Drizzle
  // directly, standing in for a row an older version wrote or a hand edit
  // left behind: payload_captured true, nothing actually stored.
  const id = uuidv7()
  await db.insert(requestLogs).values({
    id, model: 'house-model', status: 200, outcome: 'ok', latencyMs: 10,
    payloadCaptured: true, requestJson: null, responseJson: null,
  })

  const detail = await postgresStore.get(id)
  expect(detail?.payloadCaptured).toBe(true)
  expect(detail?.payload).toBeNull()
})

test('a truncated payload keeps its flag', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({
    id,
    payload: { request: { truncated: true, bytes: 91234, preview: 'x' }, response: null, truncated: true },
  }))
  expect((await postgresStore.get(id))?.payload?.truncated).toBe(true)
})

test('filters by key, model, status class and outcome', async () => {
  const ok1 = uuidv7(); const bad = uuidv7(); const oops = uuidv7()
  await postgresStore.write(entry({ id: ok1, model: 'a', status: 200, outcome: 'ok' }))
  await postgresStore.write(entry({ id: bad, model: 'b', status: 429, outcome: 'error' }))
  await postgresStore.write(entry({ id: oops, model: 'a', status: 502, outcome: 'error' }))

  expect((await postgresStore.query({ limit: 10, model: 'a' })).rows).toHaveLength(2)
  expect((await postgresStore.query({ limit: 10, statusClass: 'client_error' })).rows)
    .toMatchObject([{ id: bad }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'server_error' })).rows)
    .toMatchObject([{ id: oops }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'success' })).rows)
    .toMatchObject([{ id: ok1 }])
  expect((await postgresStore.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(2)
})

test('pages newest first and walks both directions', async () => {
  const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  for (const id of ids) await postgresStore.write(entry({ id }))
  const [r1, r2, r3, r4, r5] = ids

  const first = await postgresStore.query({ limit: 2 })
  expect(first.rows.map((r) => r.id)).toEqual([r5, r4])
  expect(first.nextCursor).not.toBeNull()

  const second = await postgresStore.query({ limit: 2, after: first.nextCursor! })
  expect(second.rows.map((r) => r.id)).toEqual([r3, r2])

  const back = await postgresStore.query({ limit: 2, before: second.prevCursor! })
  expect(back.rows.map((r) => r.id)).toEqual([r5, r4])
  expect(r1).toBeDefined()
})

test('prevCursor is null once before-paging reaches the newest row', async () => {
  const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  for (const id of ids) await postgresStore.write(entry({ id }))

  const top = await postgresStore.query({ limit: 2, before: ids[3] })
  expect(top.rows.map((r) => r.id)).toEqual([ids[4]])
  expect(top.prevCursor).toBeNull()
})

test('an over-long model name is truncated rather than failing the write', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, model: 'm'.repeat(400) }))
  expect((await postgresStore.get(id))?.model).toHaveLength(128)
})

test('a time range filter selects by id bound', async () => {
  // request_logs has no DEFAULT partition (see partitions.test.ts's "a write
  // with no partition for its month fails"), so a write into an arbitrary
  // future month needs its partition provisioned first.
  await ensurePartitions(pool, new Date('2030-04-01T00:00:00Z'))
  const older = uuidv7(new Date('2030-04-10T00:00:00Z'))
  const newer = uuidv7(new Date('2030-05-10T00:00:00Z'))
  await postgresStore.write(entry({ id: older }))
  await postgresStore.write(entry({ id: newer }))

  const rows = (await postgresStore.query({ limit: 10, from: new Date('2030-05-01T00:00:00Z') })).rows
  expect(rows).toMatchObject([{ id: newer }])
})

test('paging crosses a partition boundary', async () => {
  // Two months, so the query is a Merge Append over two partitions rather
  // than a scan of one. Keyset paging has to stay correct across that seam.
  await ensurePartitions(pool, new Date('2030-04-01T00:00:00Z'))
  const april = uuidv7(new Date('2030-04-20T00:00:00Z'))
  const may = uuidv7(new Date('2030-05-20T00:00:00Z'))
  await postgresStore.write(entry({ id: april }))
  await postgresStore.write(entry({ id: may }))

  const first = await postgresStore.query({ limit: 1 })
  expect(first.rows.map((r) => r.id)).toEqual([may])
  const second = await postgresStore.query({ limit: 1, after: first.nextCursor! })
  expect(second.rows.map((r) => r.id)).toEqual([april])
})

test('maintain provisions the current month and drops what fell out of the window', async () => {
  const now = new Date('2030-06-15T00:00:00Z')
  const settings = { store: 'postgres', retentionMonths: 2, payloadMaxBytes: 1024 }

  await postgresStore.maintain(new Date('2030-01-15T00:00:00Z'), settings)
  const result = await postgresStore.maintain(now, settings)

  expect(result.created).toContain('request_logs_2030_06')
  expect(result.dropped).toContain('request_logs_2030_01')
  expect(result.dropped).not.toContain('request_logs_2030_06')
})

test('a written tag set comes back on the row and on the detail', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, tags: { env: 'prod', team: 'a' } }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'a' })

  const detail = await postgresStore.get(id)
  expect(detail?.tags).toEqual({ env: 'prod', team: 'a' })
})

// The distinction this column exists to preserve: a request that sent no
// header must be NULL, never {}, so it stays distinguishable from a row
// written before the feature existed.
test('an entry with no tags stores SQL NULL, not an empty object', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toBeNull()

  const [row] = await db
    .select({ isNull: sql<boolean>`${requestLogs.tags} IS NULL` })
    .from(requestLogs)
    .where(eq(requestLogs.id, id))
  expect(row.isNull).toBe(true)
})

test('an empty tag object is stored as NULL rather than {}', async () => {
  const id = uuidv7()
  await postgresStore.write(entry({ id, tags: {} }))

  const [row] = await db
    .select({ isNull: sql<boolean>`${requestLogs.tags} IS NULL` })
    .from(requestLogs)
    .where(eq(requestLogs.id, id))
  expect(row.isNull).toBe(true)
})

/** Five rows whose tags (and, for the fifth, status) differ, for the
 * containment cases below. Uses the `entry()` helper already defined at the
 * top of this file. The fifth row carries status: 500 alongside env: 'prod'
 * so a test combining a tag filter with statusClass: 'success' has a row
 * that the tag filter alone would wrongly include. */
async function seedTagged() {
  const rows: Array<Partial<RequestLogEntry>> = [
    { tags: { env: 'prod', team: 'a' } },
    { tags: { env: 'prod', team: 'b' } },
    { tags: { env: 'staging', team: 'a' } },
    { tags: null },
    { tags: { env: 'prod' }, status: 500 },
  ]
  for (const overrides of rows) {
    await postgresStore.write(entry(overrides))
  }
}

test('one pair matches every row carrying it', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod' } })
  expect(page.rows).toHaveLength(3)
})

test('two pairs are ANDed, not ORed', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod', team: 'a' } })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'a' })
})

test('a row matches a filter naming only some of its tags', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { team: 'b' } })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].tags).toEqual({ env: 'prod', team: 'b' })
})

// A NULL column yields NULL under @>, not true — so an untagged row, and
// every row written before this column existed, is excluded rather than
// matching an empty set.
test('an untagged row matches no tag filter', async () => {
  await seedTagged()
  const page = await postgresStore.query({ limit: 10, tags: { env: 'prod' } })
  expect(page.rows.every((row) => row.tags !== null)).toBe(true)
})

test('a tag filter combines with the other filters', async () => {
  await seedTagged()
  const page = await postgresStore.query({
    limit: 10,
    tags: { env: 'prod' },
    statusClass: 'success',
  })
  expect(page.rows).toHaveLength(2)
})

test('a value containing SQL syntax is parameterized, not interpolated', async () => {
  await seedTagged()
  const page = await postgresStore.query({
    limit: 10,
    tags: { env: "prod' OR 1=1 --" },
  })
  expect(page.rows).toHaveLength(0)
})
