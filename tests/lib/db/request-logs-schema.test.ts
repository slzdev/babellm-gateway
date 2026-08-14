import { beforeEach, expect, test } from 'vitest'
import { db, pool } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { partitionName } from '@/lib/logs/partitions'
import { uuidv7 } from '@/lib/uuid'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('a log row round-trips with an app-generated v7 id', async () => {
  const [row] = await db.insert(requestLogs).values({
    id: uuidv7(),
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

test('a row routes to the partition its id encodes', async () => {
  // resetDb provisions the current month, so minting the id against "now"
  // guarantees a home for it without provisioning anything extra here.
  const now = new Date()
  const id = uuidv7(now)
  await db.insert(requestLogs).values({ id, status: 200, outcome: 'ok', latencyMs: 1 })

  const { rows } = await pool.query(
    'SELECT tableoid::regclass::text AS partition FROM request_logs WHERE id = $1',
    [id],
  )
  expect(rows[0]?.partition).toBe(partitionName(now))
})

test('cost columns keep nine decimal places', async () => {
  const [row] = await db.insert(requestLogs).values({
    id: uuidv7(), status: 200, outcome: 'ok', latencyMs: 1,
    costUsd: '0.000000123',
  }).returning()

  expect(Number(row.costUsd)).toBeCloseTo(0.000000123, 12)
})
