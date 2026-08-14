import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { beforeEach, expect, test, vi } from 'vitest'
import { createDynamoStore } from '@/lib/logs/dynamodb'
import { shardKey } from '@/lib/logs/dynamodb/keys'
import { toItem } from '@/lib/logs/dynamodb/item'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { ReadableRequestLogStore, RequestLogEntry } from '@/lib/logs/types'
import { resetLogsTable, seedItems, testDynamoConfig } from '../../../helpers/dynamo'
import { storeContract } from '../store-contract'

const config = testDynamoConfig()
const when = config ? test : test.skip

const settings: LoggingSettings = {
  store: 'dynamodb', retentionMonths: 3, payloadMaxBytes: 262_144,
}

let store: ReadableRequestLogStore

beforeEach(async () => {
  if (!config) return
  await resetLogsTable()
  store = createDynamoStore({ table: config.table, endpoint: config.endpoint, region: config.region })
})

// Guarded, not skipped: without the container there is no `store` for the
// suite to call at all. The driver-specific tests above use test.skip for the
// same reason.
if (config) storeContract('dynamodb', () => store)

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

when('a written entry comes back from get under every shard', async () => {
  // One id per hex digit, built by substituting the last character, so all
  // sixteen shards are covered deterministically in sixteen writes rather
  // than probabilistically in two hundred. A get() that derived the wrong
  // partition would fail here and nowhere else.
  const base = uuidv7()
  const ids = '0123456789abcdef'.split('').map((hex) => base.slice(0, -1) + hex)

  for (const id of ids) await store.write(entry({ id }), settings)

  for (const id of ids) {
    expect((await store.get(id))?.id).toBe(id)
  }
})

when('query returns rows newest first across shards', async () => {
  const ids = Array.from({ length: 40 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  const page = await store.query({ limit: 40 })
  expect(page.rows.map((r) => r.id)).toEqual([...ids].reverse())
})

when('paging forwards and back returns the same rows', async () => {
  const ids = Array.from({ length: 30 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  const first = await store.query({ limit: 10 })
  expect(first.rows).toHaveLength(10)
  expect(first.nextCursor).not.toBeNull()
  expect(first.prevCursor).toBeNull()

  const second = await store.query({ limit: 10, after: first.nextCursor! })
  expect(second.rows).toHaveLength(10)
  expect(second.rows[0].id).not.toBe(first.rows[9].id)

  const back = await store.query({ limit: 10, before: second.prevCursor! })
  expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
})

when('filters narrow the page', async () => {
  await store.write(entry({ model: 'alpha', status: 200 }), settings)
  await store.write(entry({ model: 'beta', status: 500, outcome: 'error' }), settings)
  await store.write(entry({ model: 'alpha', status: 404 }), settings)

  expect((await store.query({ limit: 10, model: 'alpha' })).rows).toHaveLength(2)
  expect((await store.query({ limit: 10, statusClass: 'success' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, statusClass: 'client_error' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, statusClass: 'server_error' })).rows).toHaveLength(1)
  expect((await store.query({ limit: 10, outcome: 'error' })).rows).toHaveLength(1)
})

when('a filtered query uses a far larger per-shard Limit than an unfiltered one', async () => {
  // Pins FILTERED_SHARD_LIMIT (dynamodb/index.ts) directly and cheaply. The
  // budget-tripping tests further down prove the value is "large enough to
  // make MAX_ITEMS_EXAMINED reachable"; this proves the specific number,
  // without needing thousands of writes to observe it.
  // QueryCommand goes through the document client's own send(), not the raw
  // DynamoDBClient's — unlike the DescribeTimeToLive call the TTL test above
  // spies on.
  const sendSpy = vi.spyOn(DynamoDBDocumentClient.prototype, 'send')

  await store.query({ limit: 10 })
  const unfiltered = sendSpy.mock.calls[0][0] as { input: { Limit?: number } }

  sendSpy.mockClear()
  await store.query({ limit: 10, model: 'anything' })
  const filtered = sendSpy.mock.calls[0][0] as { input: { Limit?: number } }

  sendSpy.mockRestore()
  expect(filtered.input.Limit).toBe(250)
  expect(unfiltered.input.Limit).toBeLessThan(20)
})

when('the apiKeyId filter matches its key and excludes others', async () => {
  // apiKeyId is the one filter that crosses a name change: RequestLogEntry
  // carries it as `keyId` but toItem writes it, and filtersFor matches it,
  // as `apiKeyId`. A rename bug on either side returns zero rows forever
  // with no error, which the other three filters (matched under their own
  // names) cannot catch.
  await store.write(entry({ keyId: 'key-abc' }), settings)
  await store.write(entry({ keyId: 'key-xyz' }), settings)
  await store.write(entry({ keyId: null }), settings)

  expect((await store.query({ limit: 10, apiKeyId: 'key-abc' })).rows).toHaveLength(1)
})

when('a written row comes back with every projected field intact', async () => {
  // Every other test only inspects `id`, `.length`, or set membership, so a
  // LIST_ATTRIBUTES entry silently dropped (or a field wired to the wrong
  // attribute) would leave every other test green while the list view
  // rendered "Invalid Date", NaN, or an undefined outcome. This asserts the
  // whole row's projected content against distinctive values.
  const id = uuidv7()
  await store.write(entry({
    id,
    keyName: 'distinctive-key-name',
    model: 'distinctive-model',
    stream: true,
    status: 201,
    outcome: 'error',
    latencyMs: 4321,
    ttftMs: 123,
    final: {
      targetId: 'target-1',
      providerId: 'provider-1',
      provider: 'distinctive-provider',
      upstreamModel: 'distinctive-upstream-model',
    },
    usage: { promptTokens: 11, completionTokens: 22, cachedTokens: null, reasoningTokens: null },
    cost: { inputUsd: '0.01', cachedUsd: null, outputUsd: '0.02', totalUsd: '0.03', pricing: null },
    // A boolean asserted at its own default (false) can't distinguish "wired
    // correctly and false" from "attribute dropped and read as false" —
    // toRow derives payloadCaptured as `item.payloadCaptured === true`, which
    // is false either way. Only asserting the true case, as here, makes a
    // dropped LIST_ATTRIBUTES entry for it observable.
    payload: { request: { a: 1 }, response: { b: 2 }, truncated: false },
  }), settings)

  const page = await store.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  const [row] = page.rows
  expect(Number.isNaN(row.createdAt.getTime())).toBe(false)
  expect(row).toMatchObject({
    id,
    keyName: 'distinctive-key-name',
    model: 'distinctive-model',
    stream: true,
    status: 201,
    outcome: 'error',
    latencyMs: 4321,
    ttftMs: 123,
    finalProvider: 'distinctive-provider',
    finalUpstreamModel: 'distinctive-upstream-model',
    promptTokens: 11,
    completionTokens: 22,
    costUsd: '0.03',
    payloadCaptured: true,
  })
})

when('a shard needing more than one round trip still returns every row in order', async () => {
  // All twenty-five ids are forced into the same shard (last hex digit fixed
  // at 'a'), and the per-shard page size for limit:10 is small enough that
  // one shard alone cannot be drained in a single fetch. Getting this right
  // depends on the driver forwarding ExclusiveStartKey/LastEvaluatedKey
  // between rounds — drop that wiring and the same head page repeats forever
  // instead of the query ever reaching the older rows.
  const ids = Array.from({ length: 25 }, () => uuidv7().slice(0, -1) + 'a')
  for (const id of ids) await store.write(entry({ id }), settings)

  const sorted = [...ids].sort()
  const page = await store.query({ limit: 10 })
  expect(page.rows.map((r) => r.id)).toEqual(sorted.slice(-10).reverse())
})

// A filtered Query's per-shard Limit is 250 (FILTERED_SHARD_LIMIT in
// dynamodb/index.ts) — DynamoDB reads up to 1 MB server-side once a
// FilterExpression is present regardless of Limit, so a larger Limit costs
// the same round trip while making MAX_ITEMS_EXAMINED (10,000) reachable at
// all. With every non-matching id forced into one shard, that shard alone
// accumulates ~250 examined per round after round one, so it takes forty
// rounds — MAX_ROUND_TRIPS — to cross the item budget. NO_MATCH_COUNT clears
// that with margin so the shard is still not exhausted (has more items left
// to page through) when the budget trips, rather than finishing early and
// changing what these tests are actually exercising.
const NO_MATCH_COUNT = 10_050

when('a budget-truncated query still surfaces a match it already fetched', async () => {
  // End-to-end regression for the drain in collectPage: shard 'b' gets
  // NO_MATCH_COUNT items that never match the filter, forcing the budget to
  // trip with shard 'b' still not exhausted. Shard 'a' gets exactly one item
  // that *does* match, generated after all of shard 'b's ids so it sorts
  // newest and wins the merge outright in round one — then sits untouched in
  // its buffer while shard 'b' alone burns through the rest of the budget.
  // Without the drain, that already-fetched match would be silently
  // dropped; with it, it comes back as a normal row.
  //
  // Seeded via seedItems/BatchWriteItem, not store.write() — the item count
  // is load-bearing (it has to exceed the budget for the trip to happen at
  // all), but one PutItem per item made this test take ~6s on its own;
  // batches of 25 cut that by roughly the same factor.
  const noMatchIds = Array.from({ length: NO_MATCH_COUNT }, () => `${uuidv7().slice(0, -1)}b`)
  const matchId = `${uuidv7().slice(0, -1)}a`
  await seedItems(
    config!.table,
    noMatchIds.map((id) => toItem(entry({ id, model: 'no-match' }), settings)),
  )
  await store.write(entry({ id: matchId, model: 'match-me' }), settings)

  const page = await store.query({ limit: 1, model: 'match-me' })

  expect(page.rows.map((r) => r.id)).toEqual([matchId])
  expect(page.nextCursor).toBe(matchId)
})

when('a query matching nothing anywhere still gets a resumable cursor after truncation', async () => {
  // The original bug, end-to-end: a narrow filter over a wide range reads a
  // great deal and matches nothing until it goes deep. Shard 'b' alone
  // supplies NO_MATCH_COUNT non-matching items — same budget arithmetic as
  // above — so this trips the budget with every shard's buffer empty (no
  // match exists anywhere for the drain to recover). The page must not
  // render as an indistinguishable "no matching logs": nextCursor has to be
  // non-null so the viewer can keep paging into the unscanned tail.
  const noMatchIds = Array.from({ length: NO_MATCH_COUNT }, () => `${uuidv7().slice(0, -1)}b`)
  await seedItems(
    config!.table,
    noMatchIds.map((id) => toItem(entry({ id, model: 'no-match' }), settings)),
  )

  const page = await store.query({ limit: 1, model: 'match-me' })

  expect(page.rows).toEqual([])
  expect(page.nextCursor).not.toBeNull()
})

when('get resolves an uppercase-hex form of a written id', async () => {
  // UUID_RE accepts uppercase hex, but shardKey() only lowercases the last
  // character and sk is a case-sensitive string, so an unnormalized get()
  // would miss a row Postgres — which normalizes uuid literals — still
  // finds for the same hand-edited URL.
  const id = uuidv7()
  await store.write(entry({ id }), settings)

  expect((await store.get(id.toUpperCase()))?.id).toBe(id)
})

when('a time range selects on the id, which is the clock', async () => {
  const old = uuidv7(new Date('2026-01-01T00:00:00Z'))
  const recent = uuidv7(new Date('2026-08-14T00:00:00Z'))
  await store.write(entry({ id: old }), settings)
  await store.write(entry({ id: recent }), settings)

  const page = await store.query({ limit: 10, from: new Date('2026-06-01T00:00:00Z') })
  expect(page.rows.map((r) => r.id)).toEqual([recent])
})

when('get returns null rather than throwing for a malformed id', async () => {
  // A hand-edited URL reaches this with anything at all, and a shard key
  // derived from garbage would query a partition that cannot exist.
  expect(await store.get('not-a-uuid')).toBeNull()
  expect(await store.get('')).toBeNull()
  expect(await store.get("'; DROP TABLE request_logs; --")).toBeNull()
})

when('maintain reports no partitions and does not throw', async () => {
  expect(await store.maintain(new Date(), settings)).toEqual({ created: [], dropped: [] })
})

when('maintain bounds its TTL check with an abort signal', async () => {
  // Regression guard for the boot-path hang: runLogMaintenance awaits this on
  // startup, and the AWS SDK sets no default request timeout, so an
  // unreachable endpoint would otherwise hold up serving indefinitely. This
  // asserts the bound is actually wired to the SDK call rather than
  // exercising a live timeout, which would make the suite's runtime depend
  // on network conditions.
  const sendSpy = vi.spyOn(DynamoDBClient.prototype, 'send')
  await store.maintain(new Date(), settings)
  const options = sendSpy.mock.calls.at(-1)?.[1] as { abortSignal?: unknown } | undefined
  expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
  sendSpy.mockRestore()
})

when('a settings-error resolution never stamps a TTL', async () => {
  // registry.ts's settings_error fallback hands back retentionMonths: 0, not
  // DEFAULT_RETENTION_MONTHS — because this driver stamps TTL from
  // `settings` at write time and its retention is explicitly non-retroactive,
  // a guessed value written here would be permanent for as long as the
  // outage that produced it. This writes with exactly the settings shape
  // that fallback returns and inspects the raw item, since get()'s LogDetail
  // never surfaces expiresAt at all.
  const id = uuidv7()
  await store.write(entry({ id }), { store: 'postgres', retentionMonths: 0, payloadMaxBytes: 262_144 })

  const raw = new DynamoDBClient({ region: config!.region, endpoint: config!.endpoint })
  const out = await raw.send(new GetItemCommand({
    TableName: config!.table,
    Key: { pk: { S: shardKey(id) }, sk: { S: id } },
  }))
  expect(out.Item?.expiresAt).toBeUndefined()
})

when('a missing table produces an error naming it', async () => {
  const missing = createDynamoStore({
    table: 'no_such_table', endpoint: config!.endpoint, region: config!.region,
  })
  await expect(missing.query({ limit: 10 })).rejects.toThrow(/no_such_table/)
})
