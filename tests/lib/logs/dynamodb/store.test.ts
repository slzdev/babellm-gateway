import { beforeEach, expect, test } from 'vitest'
import { createDynamoStore } from '@/lib/logs/dynamodb'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { ReadableRequestLogStore, RequestLogEntry } from '@/lib/logs/types'
import { resetLogsTable, testDynamoConfig } from '../../../helpers/dynamo'

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
    payloadCaptured: false,
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

when('an inverted before/after range returns empty instead of throwing', async () => {
  // A hand-edited URL can carry both cursors with before > after — boundsFor
  // then produces lo > hi, which DynamoDB's BETWEEN rejects outright.
  // parseLogFilter's contract is that a malformed URL falls back to the
  // default view, not an error page, and that's what Postgres does for the
  // same input (it only ever applies one of after/before per query).
  const ids = Array.from({ length: 5 }, () => uuidv7())
  for (const id of ids) await store.write(entry({ id }), settings)

  const page = await store.query({ limit: 10, after: ids[0], before: ids[4] })
  expect(page).toEqual({ rows: [], nextCursor: null, prevCursor: null })
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

when('a missing table produces an error naming it', async () => {
  const missing = createDynamoStore({
    table: 'no_such_table', endpoint: config!.endpoint, region: config!.region,
  })
  await expect(missing.query({ limit: 10 })).rejects.toThrow(/no_such_table/)
})
