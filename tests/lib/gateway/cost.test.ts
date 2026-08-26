import { expect, test } from 'vitest'
import { costPayload, withUsageCost } from '@/lib/gateway/cost'
import type { CostBreakdown } from '@/lib/logs/types'

const breakdown: CostBreakdown = {
  inputUsd: '0.003000000',
  cachedUsd: '0.000000000',
  outputUsd: '0.005100000',
  totalUsd: '0.008100000',
  pricing: {
    inputPerMtok: '2.500000',
    cachedInputPerMtok: '0.250000',
    outputPerMtok: '15.000000',
  },
}

test('renders the breakdown in snake_case with a currency', () => {
  expect(costPayload(breakdown)).toEqual({
    currency: 'USD',
    input: '0.003000000',
    cached: '0.000000000',
    output: '0.005100000',
    total: '0.008100000',
  })
})

test('never leaks the catalog rates to the client', () => {
  // The whole reason this function exists rather than shipping CostBreakdown
  // directly. An exact key list, not a `pricing` check: a future field added
  // to CostBreakdown must fail here rather than silently reach every caller.
  expect(Object.keys(costPayload(breakdown)!).sort()).toEqual([
    'cached', 'currency', 'input', 'output', 'total',
  ])
})

test('an unpriceable request serializes to null, not to zeroes', () => {
  expect(costPayload(null)).toBeNull()
})

test('keeps money as strings at nine decimals', () => {
  const payload = costPayload(breakdown)!
  expect(typeof payload.total).toBe('string')
  expect(payload.total).toBe('0.008100000')
})

test('attaches the cost inside the usage object', () => {
  const res = { id: 'chatcmpl-1', usage: { prompt_tokens: 5, completion_tokens: 2 } }
  expect(withUsageCost(res, costPayload(breakdown))).toEqual({
    id: 'chatcmpl-1',
    usage: {
      prompt_tokens: 5,
      completion_tokens: 2,
      cost: {
        currency: 'USD',
        input: '0.003000000',
        cached: '0.000000000',
        output: '0.005100000',
        total: '0.008100000',
      },
    },
  })
})

test('attaches an explicit null so a client can tell unpriced from unsupported', () => {
  const res = { id: 'chatcmpl-1', usage: { prompt_tokens: 5 } }
  expect(withUsageCost(res, null).usage).toEqual({ prompt_tokens: 5, cost: null })
})

test('never invents a usage object that upstream did not report', () => {
  // A provider with disableStreamUsage measured nothing. Fabricating a usage
  // object to carry `cost: null` would claim a measurement never taken.
  const res = { id: 'chatcmpl-1' }
  expect(withUsageCost(res, costPayload(breakdown))).toEqual({ id: 'chatcmpl-1' })
  expect('usage' in withUsageCost(res, null)).toBe(false)
})

test('leaves a null usage alone rather than spreading it', () => {
  // ChatCompletionChunk types usage as `CompletionUsage | null`, so null is a
  // shape that actually arrives, not a defensive hypothetical.
  const res = { id: 'chatcmpl-1', usage: null }
  expect(withUsageCost(res, null)).toEqual({ id: 'chatcmpl-1', usage: null })
})

test('does not mutate its input', () => {
  const usage = { prompt_tokens: 5 }
  const res = { id: 'chatcmpl-1', usage }
  withUsageCost(res, costPayload(breakdown))
  expect(usage).toEqual({ prompt_tokens: 5 })
})
