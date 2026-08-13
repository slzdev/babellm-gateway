import { expect, test } from 'vitest'
import { buildRequestLog } from '@/lib/logs/line'
import type { RequestLogEntry } from '@/lib/logs/types'

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: 'req_1', keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 42, attempts: [],
    ...overrides,
  }
}

test('a plain request keeps the shape the aggregator already parses', () => {
  expect(buildRequestLog(entry())).toMatchObject({
    lvl: 'info', msg: 'gateway.request', request_id: 'req_1',
    key: 'prod', model: 'house-model', stream: false,
    status: 200, outcome: 'ok', latency_ms: 42, attempts: [],
  })
})

test('a stream interrupted after its 200 is logged at error', () => {
  expect(buildRequestLog(entry({ outcome: 'stream_interrupted' })).lvl).toBe('error')
})

test('a 4xx is a warning and a 5xx is an error', () => {
  expect(buildRequestLog(entry({ status: 429, outcome: 'error' })).lvl).toBe('warn')
  expect(buildRequestLog(entry({ status: 502, outcome: 'error' })).lvl).toBe('error')
})

test('token counts appear only when they were measured', () => {
  expect(buildRequestLog(entry())).not.toHaveProperty('prompt_tokens')

  const withUsage = buildRequestLog(entry({
    usage: { promptTokens: 10, completionTokens: 4, cachedTokens: null, reasoningTokens: null },
  }))
  expect(withUsage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4 })
  expect(withUsage).not.toHaveProperty('cached_tokens')
})

test('cost appears only when the request could be priced', () => {
  const unpriced = buildRequestLog(entry({
    cost: { inputUsd: null, cachedUsd: null, outputUsd: null, totalUsd: null, pricing: null },
  }))
  expect(unpriced).not.toHaveProperty('cost_usd')

  const priced = buildRequestLog(entry({
    cost: {
      inputUsd: '0.000100000', cachedUsd: null, outputUsd: '0.000200000',
      totalUsd: '0.000300000', pricing: null,
    },
  }))
  expect(priced.cost_usd).toBe('0.000300000')
})
