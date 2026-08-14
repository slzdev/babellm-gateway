import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const BUCKET = new Date('2026-08-14T13:00:00Z')

const base = {
  bucket: BUCKET,
  statusClass: 'success' as const,
  requests: 1,
  unpricedRequests: 0,
  promptTokens: 10,
  completionTokens: 20,
  cachedTokens: 0,
  reasoningTokens: 0,
  inputCostUsd: '0.000001000',
  cachedCostUsd: '0',
  outputCostUsd: '0.000002000',
  costUsd: '0.000003000',
  latencySumMs: 500,
  latencyMaxMs: 500,
  latencyCount: 1,
  ttftSumMs: 0,
  ttftCount: 0,
}

test('a rollup row round-trips with nullable dimensions', async () => {
  const [row] = await db.insert(usageRollups).values(base).returning()

  expect(row.apiKeyId).toBeNull()
  expect(row.model).toBeNull()
  expect(row.provider).toBeNull()
  expect(row.costUsd).toBe('0.000003000')
})

test('two rows with the same grain collide even when dimensions are NULL', async () => {
  // Without NULLS NOT DISTINCT, Postgres treats two NULL models as distinct
  // and this second insert succeeds — silently doubling every total the
  // dashboard shows. This test is the only thing standing between that
  // clause and a future migration that quietly drops it.
  await db.insert(usageRollups).values(base)

  // drizzle-orm's node-postgres driver wraps the real pg error in `.cause`
  // rather than surfacing it on the top-level message (which just reads
  // "Failed query: ..."), so the assertion targets `.cause.message` to keep
  // checking that this is specifically a duplicate-key collision.
  const error = await db.insert(usageRollups).values(base).catch((e) => e)
  expect(error.cause?.message).toMatch(/duplicate key/)
})

test('rows differing only by model stay distinct', async () => {
  await db.insert(usageRollups).values(base)
  await db.insert(usageRollups).values({ ...base, model: 'gpt-5' })

  const rows = await db.select().from(usageRollups)
  expect(rows).toHaveLength(2)
})

test('cost keeps all nine decimal places', async () => {
  // numeric(18,9), not (12,6): a request costing less than a micro-dollar
  // must not round to 0.000000 on the way into the rollup.
  const [row] = await db
    .insert(usageRollups)
    .values({ ...base, costUsd: '0.000000123' })
    .returning()

  expect(row.costUsd).toBe('0.000000123')
})
