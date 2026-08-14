import { beforeEach, expect, test } from 'vitest'
import { db, pool } from '@/lib/db'
import { apiKeys, usageRollups, users } from '@/lib/db/schema'
import { loadBreakdown, loadRollupModels, loadSeries, loadTotals } from '@/lib/stats/query'
import { BREAKDOWN_ROW_LIMIT } from '@/lib/stats/types'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const FROM = new Date('2026-08-14T00:00:00Z')
const TO = new Date('2026-08-15T00:00:00Z')
const RANGE = { from: FROM, to: TO }

const row = (over: Partial<typeof usageRollups.$inferInsert>) => ({
  bucket: new Date('2026-08-14T13:00:00Z'),
  statusClass: 'success' as const,
  requests: 1, unpricedRequests: 0,
  promptTokens: 100, completionTokens: 50, cachedTokens: 0, reasoningTokens: 0,
  inputCostUsd: '0', cachedCostUsd: '0', outputCostUsd: '0', costUsd: '0.001000000',
  latencySumMs: 500, latencyMaxMs: 500, latencyCount: 1, ttftSumMs: 0, ttftCount: 0,
  ...over,
})

test('totals add up across buckets', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'gpt-5' }),
    row({ bucket: new Date('2026-08-14T14:00:00Z'), model: 'gpt-5', requests: 3 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(4)
  expect(totals.costUsd).toBe('0.002000000')
})

test('the error rate counts every non-success class', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 7 }),
    row({ model: 'b', statusClass: 'client_error', requests: 2 }),
    row({ model: 'c', statusClass: 'server_error', requests: 1 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(10)
  expect(totals.errorRequests).toBe(3)
})

test('average latency divides by its own count, not by requests', async () => {
  // ttft_count is 1 while requests is 2: a non-streaming request must not
  // halve the average TTFT.
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 2, latencySumMs: 1000, latencyCount: 2, ttftSumMs: 300, ttftCount: 1 }),
  ])

  const totals = await loadTotals(RANGE)
  expect(totals.avgLatencyMs).toBe(500)
  expect(totals.avgTtftMs).toBe(300)
})

test('an empty range reports zeroes and null averages', async () => {
  const totals = await loadTotals(RANGE)
  expect(totals.requests).toBe(0)
  expect(totals.costUsd).toBe('0')
  // Null, not 0: nothing was measured. A 0 ms average would be a lie of the
  // same family as an unpriced request costing $0.
  expect(totals.avgLatencyMs).toBeNull()
})

test('unpriced requests survive into the totals', async () => {
  await db.insert(usageRollups).values([row({ model: 'a', requests: 2, unpricedRequests: 2, costUsd: '0' })])

  const totals = await loadTotals(RANGE)
  expect(totals.unpricedRequests).toBe(2)
})

test('filters narrow the totals', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  const [key] = await db
    .insert(apiKeys).values({ name: 'k', keyHash: 'h', keyPrefix: 'p', userId: user.id }).returning()

  await db.insert(usageRollups).values([
    row({ model: 'gpt-5', apiKeyId: key.id, userId: user.id }),
    row({ model: 'claude', requests: 5 }),
  ])

  expect((await loadTotals({ ...RANGE, model: 'gpt-5' })).requests).toBe(1)
  expect((await loadTotals({ ...RANGE, apiKeyId: key.id })).requests).toBe(1)
  expect((await loadTotals({ ...RANGE, userId: user.id })).requests).toBe(1)
})

test('the series splits requests by status class', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', requests: 4 }),
    row({ model: 'b', statusClass: 'server_error', requests: 1 }),
  ])

  const series = await loadSeries(RANGE, 'hour')
  expect(series).toHaveLength(1)
  expect(series[0].bucket.toISOString()).toBe('2026-08-14T13:00:00.000Z')
  expect(series[0].success).toBe(4)
  expect(series[0].serverError).toBe(1)
  expect(series[0].clientError).toBe(0)
})

test('a daily grain collapses the hours of a day into one point', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'a', bucket: new Date('2026-08-14T01:00:00Z') }),
    row({ model: 'a', bucket: new Date('2026-08-14T23:00:00Z') }),
  ])

  const series = await loadSeries(RANGE, 'day')
  expect(series).toHaveLength(1)
  expect(series[0].bucket.toISOString()).toBe('2026-08-14T00:00:00.000Z')
  expect(series[0].success).toBe(2)
})

test('a daily bucket stays in UTC under a non-UTC session zone', async () => {
  // Without the explicit 'UTC' third argument to date_trunc, Postgres
  // truncates in the session's TimeZone. New York is UTC-4 in August — a
  // whole-hour offset, unlike Task 3's fractional-offset Asia/Kolkata test;
  // day grain needs an offset large enough to cross a day boundary to catch
  // this, which hour grain would not. 2026-08-14T01:00Z is still
  // 2026-08-13 local under New York, so session-zone truncation would put it
  // in the wrong day.
  await pool.query("SET TIME ZONE 'America/New_York'")
  try {
    await db.insert(usageRollups).values([row({ model: 'a', bucket: new Date('2026-08-14T01:00:00Z') })])

    const series = await loadSeries(RANGE, 'day')
    expect(series).toHaveLength(1)
    expect(series[0].bucket.toISOString()).toBe('2026-08-14T00:00:00.000Z')
  } finally {
    await pool.query('SET TIME ZONE DEFAULT')
  }
})

test('breakdown by model ranks by cost', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'cheap', costUsd: '0.000001000' }),
    row({ model: 'dear', costUsd: '9.000000000' }),
  ])

  const rows = await loadBreakdown(RANGE, 'model')
  expect(rows.map((r) => r.label)).toEqual(['dear', 'cheap'])
  expect(rows[0].costUsd).toBe('9.000000000')
})

test('breakdown by key labels a deleted key by its stored name', async () => {
  // No foreign key, so the row survives the key and still has a name to show.
  await db.insert(usageRollups).values([row({ model: 'a', apiKeyId: null, keyName: 'retired' })])

  const rows = await loadBreakdown(RANGE, 'key')
  expect(rows[0].label).toBe('retired')
})

test('breakdown labels a missing dimension rather than dropping the row', async () => {
  await db.insert(usageRollups).values([row({ model: null, provider: null })])

  expect((await loadBreakdown(RANGE, 'model'))[0].label).toBe('unknown')
  expect((await loadBreakdown(RANGE, 'provider'))[0].label).toBe('unknown')
})

test('a key renamed mid-range stays one breakdown row, not two', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  const [key] = await db
    .insert(apiKeys).values({ name: 'k', keyHash: 'h', keyPrefix: 'p', userId: user.id }).returning()

  // Same id, two different stored key_name snapshots — grouping by the label
  // column instead of the id would split one key into two rows.
  await db.insert(usageRollups).values([
    row({ model: 'a', apiKeyId: key.id, keyName: 'old' }),
    row({ model: 'a', apiKeyId: key.id, keyName: 'new', bucket: new Date('2026-08-14T14:00:00Z') }),
  ])

  const rows = await loadBreakdown(RANGE, 'key')
  expect(rows).toHaveLength(1)
  expect(rows[0].requests).toBe(2)
})

test('a breakdown returns the top rows by cost, not every row', async () => {
  // "Top rows by cost" (spec §10) has to actually be a top: a wide range on
  // a gateway with many models would otherwise return one row per model into
  // the page, unbounded.
  await db.insert(usageRollups).values(
    Array.from({ length: BREAKDOWN_ROW_LIMIT + 5 }, (_, i) => row({
      model: `m-${String(i).padStart(3, '0')}`,
      costUsd: `${String(i).padStart(3, '0')}.000000000`,
    })),
  )

  const rows = await loadBreakdown(RANGE, 'model')

  expect(rows).toHaveLength(BREAKDOWN_ROW_LIMIT)
  // The costliest, not the first inserted: the cap trims the cheap tail.
  expect(rows[0].label).toBe(`m-${String(BREAKDOWN_ROW_LIMIT + 4).padStart(3, '0')}`)
})

test('loadRollupModels offers only models that have data', async () => {
  await db.insert(usageRollups).values([
    row({ model: 'gpt-5' }),
    row({ model: 'gpt-5', bucket: new Date('2026-08-14T14:00:00Z') }),
    row({ model: 'openai/gpt-4.1' }),
  ])

  // Direct provider/model addresses too: /logs sources its dropdown from
  // virtual_models and cannot offer these at all.
  expect(await loadRollupModels()).toEqual(['gpt-5', 'openai/gpt-4.1'])
})
