import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { requestPayloads } from '@/lib/db/schema'
import { postgresStore } from '@/lib/logs/postgres'
import type { RequestLogEntry } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('a written entry comes back from query', async () => {
  await postgresStore.write(entry({ requestId: 'req_a', model: 'house-model' }))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ requestId: 'req_a', model: 'house-model', status: 200 })
})

test('get returns the attempt chain and the payload', async () => {
  await postgresStore.write(entry({
    requestId: 'req_b',
    attempts: [
      { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
      { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
    ],
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }))

  const detail = await postgresStore.get('req_b')
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0].error).toBe('down')
  expect(detail?.payloadCaptured).toBe(true)
  expect(detail?.payload?.request).toEqual({ model: 'house-model' })
})

test('get returns null for an unknown request id', async () => {
  expect(await postgresStore.get('req_missing')).toBeNull()
})

test('an entry without a payload records payload_captured false', async () => {
  await postgresStore.write(entry({ requestId: 'req_c' }))
  const detail = await postgresStore.get('req_c')
  expect(detail?.payloadCaptured).toBe(false)
  expect(detail?.payload).toBeNull()
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('filters by key, model, status class and outcome', async () => {
  await postgresStore.write(entry({ requestId: 'ok1', model: 'a', status: 200, outcome: 'ok' }))
  await postgresStore.write(entry({ requestId: 'bad', model: 'b', status: 429, outcome: 'error' }))
  await postgresStore.write(entry({ requestId: 'oops', model: 'a', status: 502, outcome: 'error' }))

  expect((await postgresStore.query({ limit: 10, model: 'a' })).rows).toHaveLength(2)
  expect((await postgresStore.query({ limit: 10, statusClass: 'client_error' })).rows)
    .toMatchObject([{ requestId: 'bad' }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'server_error' })).rows)
    .toMatchObject([{ requestId: 'oops' }])
  expect((await postgresStore.query({ limit: 10, statusClass: 'success' })).rows)
    .toMatchObject([{ requestId: 'ok1' }])
  expect((await postgresStore.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(2)
})

test('pages newest first and walks both directions', async () => {
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    await postgresStore.write(entry({ requestId: id }))
  }

  const first = await postgresStore.query({ limit: 2 })
  expect(first.rows.map((r) => r.requestId)).toEqual(['r5', 'r4'])
  expect(first.nextCursor).not.toBeNull()

  const second = await postgresStore.query({ limit: 2, after: first.nextCursor! })
  expect(second.rows.map((r) => r.requestId)).toEqual(['r3', 'r2'])

  const back = await postgresStore.query({ limit: 2, before: second.prevCursor! })
  expect(back.rows.map((r) => r.requestId)).toEqual(['r5', 'r4'])
})

test('prevCursor is null once before-paging reaches the newest row', async () => {
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    await postgresStore.write(entry({ requestId: id }))
  }

  const all = await postgresStore.query({ limit: 10 })
  const r4 = all.rows.find((r) => r.requestId === 'r4')!

  // Only r5 has an id greater than r4's, so paging before r4 lands exactly on
  // the newest row — there is no further "newer" page beyond it.
  const top = await postgresStore.query({ limit: 2, before: r4.id })
  expect(top.rows.map((r) => r.requestId)).toEqual(['r5'])
  expect(top.prevCursor).toBeNull()
})

test('an over-long model name is truncated rather than failing the write', async () => {
  await postgresStore.write(entry({ requestId: 'req_long', model: 'm'.repeat(400) }))
  const detail = await postgresStore.get('req_long')
  expect(detail?.model).toHaveLength(128)
})

/** Puts a real millisecond boundary between two writes. `Date.now() + 1` is
 * not enough: the following write can land in the same millisecond as the
 * bound, putting the row on the wrong side of it for reasons unrelated to the
 * code under test. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('prune deletes old rows, their payloads, and reports the count', async () => {
  await postgresStore.write(entry({ requestId: 'old', payload: { request: {}, response: {}, truncated: false } }))
  await tick()
  const cutoff = new Date()
  await tick()
  await postgresStore.write(entry({ requestId: 'new' }))

  expect(await postgresStore.prune(cutoff)).toBe(1)
  expect((await postgresStore.query({ limit: 10 })).rows).toMatchObject([{ requestId: 'new' }])
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('a time range filter selects by id bound', async () => {
  await postgresStore.write(entry({ requestId: 'before' }))
  await tick()
  const from = new Date()
  await tick()
  await postgresStore.write(entry({ requestId: 'after' }))

  expect((await postgresStore.query({ limit: 10, from })).rows)
    .toMatchObject([{ requestId: 'after' }])
})
