import { expect, test } from 'vitest'
import {
  DYNAMO_PAYLOAD_MAX_BYTES, ITEM_MAX_BYTES, expiresAtFor, toDetail, toItem, toRow,
} from '@/lib/logs/dynamodb/item'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { RequestLogEntry } from '@/lib/logs/types'

const settings: LoggingSettings = {
  store: 'dynamodb', retentionMonths: 3, payloadMaxBytes: 262_144,
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

test('the item is keyed by shard and id', () => {
  const id = uuidv7()
  const item = toItem(entry({ id }), settings)

  expect(item.sk).toBe(id)
  expect(item.pk).toBe(`log#${id.slice(-1)}`)
})

test('null fields are omitted rather than stored', () => {
  // DynamoDB is schemaless, so an absent attribute costs no bytes and no
  // write units. A typical entry carries a dozen of these.
  const item = toItem(entry({ keyId: null }), settings)

  expect(item).not.toHaveProperty('apiKeyId')
  expect(item).not.toHaveProperty('errorType')
  expect(item).not.toHaveProperty('ttftMs')
  expect(item).not.toHaveProperty('pricing')
  expect(item).not.toHaveProperty('droppedParams')
  expect(item).not.toHaveProperty('attempts')
})

test('omitted attributes read back as null, not undefined', () => {
  // This is the invariant most likely to break: the UI types promise
  // `string | null`, and an undefined would render as a blank that no
  // consumer declared.
  const detail = toDetail(toItem(entry(), settings))

  expect(detail.errorType).toBeNull()
  expect(detail.ttftMs).toBeNull()
  expect(detail.pricing).toBeNull()
  expect(detail.droppedParams).toBeNull()
  expect(detail.attempts).toEqual([])
  expect(detail.payload).toBeNull()
})

test('costs are stored as strings so numeric precision survives', () => {
  // The Postgres columns are numeric(18, 9) and drizzle hands them back as
  // strings. A DynamoDB N would round them.
  const item = toItem(entry({
    cost: {
      inputUsd: '0.000123456', cachedUsd: null,
      outputUsd: '0.000000001', totalUsd: '0.000123457',
      pricing: { inputPerMtok: '3.000000', cachedInputPerMtok: null, outputPerMtok: '15.000000' },
    },
  }), settings)

  expect(item.costUsd).toBe('0.000123457')
  expect(item.outputCostUsd).toBe('0.000000001')
  expect(typeof item.costUsd).toBe('string')
  expect(toRow(item).costUsd).toBe('0.000123457')
})

test('an over-long model name is clamped to 128 characters', () => {
  const item = toItem(entry({ model: 'm'.repeat(500) }), settings)
  expect(String(item.model)).toHaveLength(128)
})

test('payloads round-trip through their JSON string form', () => {
  const item = toItem(entry({
    payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
  }), settings)

  // Stored as strings, not native maps: payloads are arbitrary user content,
  // and native storage would hit the 32-level nesting limit and round any
  // float past 38 digits.
  expect(typeof item.requestJson).toBe('string')

  const detail = toDetail(item)
  expect(detail.payload?.request).toEqual({ model: 'house-model' })
  expect(detail.payload?.response).toEqual({ ok: true })
  expect(detail.payload?.truncated).toBe(false)
  expect(detail.payloadCaptured).toBe(true)
})

test('the stored attributes decide whether a payload exists, not the flag', () => {
  const detail = toDetail({
    ...toItem(entry(), settings), payloadCaptured: true,
  })
  expect(detail.payload).toBeNull()
})

test('an oversized payload is capped to the driver limit', () => {
  const huge = { blob: 'x'.repeat(400 * 1024) }
  const item = toItem(entry({
    payload: { request: huge, response: huge, truncated: false },
  }), settings)

  expect(String(item.requestJson).length).toBeLessThanOrEqual(DYNAMO_PAYLOAD_MAX_BYTES + 1024)
  expect(item.payloadTruncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
})

test('a runaway retry chain sheds payloads and then attempts', () => {
  // A ValidationException here would lose the whole log line, and logRequest
  // is deliberately not awaited — the loss would surface only on stderr. So
  // the item must fit by construction, not by luck. This entry is ~1.6 MB of
  // attempts on top of two 140 KiB payloads, which exercises shed stages 1
  // and 3.
  const attempts = Array.from({ length: 2000 }, (_, n) => ({
    n, targetId: 't'.repeat(200), provider: 'p'.repeat(200),
    model: 'm'.repeat(200), status: 503, latencyMs: 5, error: 'e'.repeat(200),
  }))
  const huge = { blob: 'x'.repeat(140 * 1024) }
  const item = toItem(entry({
    attempts, payload: { request: huge, response: huge, truncated: false },
  }), settings)

  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
  expect(JSON.parse(String(item.requestJson))).toEqual({
    truncated: true, error: 'too_large_for_store',
  })

  const detail = toDetail(item)
  expect(detail.attempts).toHaveLength(100)
  expect(detail.attempts[0].targetId).toHaveLength(128)
  expect(detail.attempts[0].error).toHaveLength(128)
})

test('an unbounded upstream error message is truncated rather than fatal', () => {
  // errorMessage is whatever a provider chose to return, and nothing upstream
  // bounds it. Shed stage 2.
  const item = toItem(entry({
    errorType: 'upstream_error',
    errorMessage: 'e'.repeat(1024 * 1024),
    droppedParams: ['top_k', 'seed'],
  }), settings)

  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
  expect(String(item.errorMessage)).toHaveLength(4096)
  expect(toDetail(item).errorType).toBe('upstream_error')
})

test('an oversized error code is clamped, not shed', () => {
  // errorCode comes off ProviderError, built straight from an upstream's
  // JSON error body — an "OpenAI-compatible" third party can put an
  // arbitrarily long string here. No shed stage touches errorCode, so unlike
  // errorMessage this has to be bounded unconditionally at write, the same
  // way model already is.
  const item = toItem(entry({ errorCode: 'e'.repeat(1_000_000) }), settings)

  expect(Buffer.byteLength(JSON.stringify(item), 'utf8')).toBeLessThanOrEqual(ITEM_MAX_BYTES)
  expect(String(item.errorCode)).toHaveLength(128)
})

test('the TTL mirrors the partition retention policy', () => {
  // dropExpiredPartitions drops month M when M < addMonths(now, -(n - 1)),
  // which is the same as: when now >= addMonths(M, n).
  const written = new Date('2026-08-14T16:13:00Z')
  expect(expiresAtFor(written, 3))
    .toBe(Math.floor(Date.UTC(2026, 10, 1) / 1000))
})

test('retention of zero means keep forever, so no TTL is stamped', () => {
  expect(expiresAtFor(new Date('2026-08-14T00:00:00Z'), 0)).toBeNull()

  const item = toItem(entry(), { ...settings, retentionMonths: 0 })
  expect(item).not.toHaveProperty('expiresAt')
})

test('createdAt is stamped at write time and reads back as a Date', () => {
  const writtenAt = new Date('2026-08-14T16:13:00Z')
  const row = toRow(toItem(entry(), settings, writtenAt))

  expect(row.createdAt).toBeInstanceOf(Date)
  expect(row.createdAt.toISOString()).toBe('2026-08-14T16:13:00.000Z')
})
