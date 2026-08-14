import { beforeEach, expect, test } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { apiKeys, requestLogs, usageRollups, users } from '@/lib/db/schema'
import { aggregateRange } from '@/lib/stats/aggregate'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const HOUR = new Date('2026-08-14T13:00:00Z')
const RANGE = { from: HOUR, to: new Date('2026-08-14T14:00:00Z') }

const at = (iso: string) => new Date(iso)

async function rollups() {
  return db.select().from(usageRollups).orderBy(asc(usageRollups.bucket))
}

/** Runs one recompute the way the job does: inside a transaction. */
async function run(range = RANGE): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const rows = await aggregateRange(client, range)
    await client.query('COMMIT')
    return rows
  } finally {
    client.release()
  }
}

test('requests in one hour collapse into one row', async () => {
  // Every cost column and every token column below is a distinct value, and
  // no two of the four summed costs (or four summed token counts) collide —
  // a column transposition (e.g. cached_cost_usd and output_cost_usd
  // swapped in the INSERT) must fail one of these assertions. Asserting only
  // cost_usd, as this test once did, cannot catch that: cost_usd is its own
  // column, untouched by a transposition among the three components.
  await insertLog({
    at: at('2026-08-14T13:05:00Z'),
    promptTokens: 100, completionTokens: 50, cachedTokens: 10, reasoningTokens: 5,
    inputCostUsd: '0.000011000', cachedCostUsd: '0.000000700',
    outputCostUsd: '0.000022000', costUsd: '0.000033700',
  })
  await insertLog({
    at: at('2026-08-14T13:45:00Z'),
    promptTokens: 200, completionTokens: 70, cachedTokens: 30, reasoningTokens: 15,
    inputCostUsd: '0.000033000', cachedCostUsd: '0.000001300',
    outputCostUsd: '0.000044000', costUsd: '0.000078300',
  })

  expect(await run()).toBe(1)

  const [row] = await rollups()
  expect(row.bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
  expect(row.requests).toBe(2)
  expect(row.promptTokens).toBe(300)
  expect(row.completionTokens).toBe(120)
  expect(row.cachedTokens).toBe(40)
  expect(row.reasoningTokens).toBe(20)
  expect(row.inputCostUsd).toBe('0.000044000')
  expect(row.cachedCostUsd).toBe('0.000002000')
  expect(row.outputCostUsd).toBe('0.000066000')
  expect(row.costUsd).toBe('0.000112000')
  expect(row.model).toBe('gpt-5')
  expect(row.provider).toBe('openai')
  expect(row.statusClass).toBe('success')
})

test('requests in different hours land in different buckets', async () => {
  await insertLog({ at: at('2026-08-14T13:30:00Z') })
  await insertLog({ at: at('2026-08-14T14:30:00Z') })

  await run({ from: HOUR, to: at('2026-08-14T15:00:00Z') })

  const rows = await rollups()
  expect(rows.map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T13:00:00.000Z',
    '2026-08-14T14:00:00.000Z',
  ])
})

test('status maps to the same three classes /logs filters by', async () => {
  await insertLog({ at: at('2026-08-14T13:01:00Z'), status: 200 })
  await insertLog({ at: at('2026-08-14T13:02:00Z'), status: 429, outcome: 'error' })
  await insertLog({ at: at('2026-08-14T13:03:00Z'), status: 500, outcome: 'error' })

  await run()

  const rows = await rollups()
  expect(rows.map((r) => r.statusClass).sort())
    .toEqual(['client_error', 'server_error', 'success'])
})

test('running the same range twice produces identical rows', async () => {
  // Idempotency is the entire premise of recompute-over-increment. Without
  // this test that premise is a claim, and a double-counting regression would
  // show up as numbers that are merely wrong rather than as a failure.
  await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await insertLog({ at: at('2026-08-14T13:45:00Z') })

  await run()
  const first = await rollups()
  await run()
  const second = await rollups()

  expect(second).toEqual(first)
})

test('a combination that stopped occurring is removed, not left behind', async () => {
  // The other half of what recompute buys over increment.
  const id = await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await run()
  expect(await rollups()).toHaveLength(1)

  await db.delete(requestLogs).where(eq(requestLogs.id, id))
  await run()

  expect(await rollups()).toHaveLength(0)
})

test('a key renamed mid-hour produces one row, not a unique violation', async () => {
  // request_logs.key_name is denormalized at write time, so a rename puts two
  // names on rows sharing every grain column. Grouping by the name would emit
  // two rows for one grain and the unique constraint would reject the second
  // — the tick would fail, and keep failing until that bucket sealed.
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'before', keyHash: 'h1', keyPrefix: 'sk-a' })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'before' })
  await insertLog({ at: at('2026-08-14T13:45:00Z'), apiKeyId: key.id, keyName: 'after' })

  expect(await run()).toBe(1)

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(['before', 'after']).toContain(row.keyName)
})

test('the user is resolved through the key and frozen on the row', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'ada-key', keyHash: 'h2', keyPrefix: 'sk-b', userId: user.id })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'ada-key' })
  await run()

  const [row] = await rollups()
  expect(row.userId).toBe(user.id)
  expect(row.userName).toBe('Ada')
})

test('unpriced requests are counted, not silently worth zero', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z') })
  await insertLog({
    at: at('2026-08-14T13:10:00Z'),
    inputCostUsd: null, cachedCostUsd: null, outputCostUsd: null, costUsd: null,
  })

  await run()

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(row.unpricedRequests).toBe(1)
  expect(row.costUsd).toBe('0.000300000')
})

test('non-streaming requests do not drag the TTFT denominator', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z'), stream: true, ttftMs: 300 })
  await insertLog({ at: at('2026-08-14T13:10:00Z'), ttftMs: null })

  await run()

  const [row] = await rollups()
  expect(row.requests).toBe(2)
  expect(row.ttftCount).toBe(1)
  expect(row.ttftSumMs).toBe(300)
  // Not asserting latencyCount here: latency_ms is NOT NULL on request_logs,
  // so count(rl.latency_ms) is identical to count(*) by construction — that
  // assertion would pass no matter what the implementation does, and this
  // test's job is to discriminate ttft_count from requests, not to restate
  // latencyCount.
})

test('latency carries a sum, a count and a max', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z'), latencyMs: 100 })
  await insertLog({ at: at('2026-08-14T13:10:00Z'), latencyMs: 900 })

  await run()

  const [row] = await rollups()
  expect(row.latencySumMs).toBe(1000)
  expect(row.latencyCount).toBe(2)
  expect(row.latencyMaxMs).toBe(900)
})

test('recomputing one hour does not disturb a different, already-sealed hour', async () => {
  // Every other test truncates the table before each run, so a rollup row
  // is never present outside the range being recomputed — an unbounded
  // DELETE (say, one that lost its WHERE clause, or grew an `OR true`) would
  // still leave every one of those tests green. This test builds a second,
  // already-computed hour first, so a DELETE that reaches beyond `range`
  // wipes it out and the assertion below catches it.
  await insertLog({ at: at('2026-08-14T12:30:00Z') })
  await insertLog({ at: at('2026-08-14T13:30:00Z') })

  await run({ from: at('2026-08-14T12:00:00Z'), to: HOUR }) // seals 12:00 first
  await run() // then recomputes 13:00 (the default RANGE)

  const rows = await rollups()
  expect(rows.map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T12:00:00.000Z',
    '2026-08-14T13:00:00.000Z',
  ])
})

test('a log exactly at range.from is included, one exactly at range.to is excluded', async () => {
  // The range is half-open — from inclusive, to exclusive. uuidv7Bound(t) is
  // the lowest possible id for instant t, so a log minted at exactly that
  // instant always sorts at or above the bound, which is what makes the
  // boundary itself worth testing rather than just a millisecond either side
  // of it.
  await insertLog({ at: RANGE.from })
  await insertLog({ at: RANGE.to })

  await run()

  const rows = await rollups()
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
  expect(rows[0].requests).toBe(1)
})

test('deleting an API key leaves its rollup rows intact', async () => {
  // request_logs uses ON DELETE SET NULL; usage_rollups has no foreign key at
  // all, because SET NULL on a column inside the unique constraint would make
  // this delete fail once two keys' rows collapsed onto the same NULL grain.
  const [key] = await db
    .insert(apiKeys)
    .values({ name: 'doomed', keyHash: 'h3', keyPrefix: 'sk-c' })
    .returning()

  await insertLog({ at: at('2026-08-14T13:05:00Z'), apiKeyId: key.id, keyName: 'doomed' })
  await run()

  await db.delete(apiKeys)

  const [row] = await rollups()
  expect(row.apiKeyId).toBe(key.id)
  expect(row.keyName).toBe('doomed')
})
