import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requestLogs, requestPayloads } from '@/lib/db/schema'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('a log row round-trips with an app-generated v7 id', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_one',
    keyName: 'prod',
    model: 'house-model',
    status: 200,
    outcome: 'ok',
    latencyMs: 120,
    attempts: [{ n: 1, targetId: 't', provider: 'openai', model: 'gpt-4o-mini', status: 200, latencyMs: 100 }],
  }).returning()

  expect(row.id[14]).toBe('7')
  expect(row.attempts[0].provider).toBe('openai')
  expect(row.costUsd).toBeNull()
  expect(row.payloadCaptured).toBe(false)
})

test('deleting a log cascades to its payload', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_two', status: 200, outcome: 'ok', latencyMs: 1,
  }).returning()

  await db.insert(requestPayloads).values({
    requestLogId: row.id,
    requestJson: { model: 'house-model' },
    responseJson: { ok: true },
  })

  await db.delete(requestLogs).where(eq(requestLogs.id, row.id))
  expect(await db.select().from(requestPayloads)).toHaveLength(0)
})

test('cost columns keep nine decimal places', async () => {
  const [row] = await db.insert(requestLogs).values({
    requestId: 'req_three', status: 200, outcome: 'ok', latencyMs: 1,
    costUsd: '0.000000123',
  }).returning()

  expect(Number(row.costUsd)).toBeCloseTo(0.000000123, 12)
})
