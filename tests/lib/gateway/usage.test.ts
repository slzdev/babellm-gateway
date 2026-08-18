import { expect, test } from 'vitest'
import { usageFromResponses } from '@/lib/gateway/usage'

test('normalizes Responses usage onto the same LogUsage shape', () => {
  expect(usageFromResponses({
    input_tokens: 7, output_tokens: 3,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  })).toEqual({ promptTokens: 7, completionTokens: 3, cachedTokens: 2, reasoningTokens: 1 })
})

test('leaves unmeasured Responses counts null rather than zero', () => {
  expect(usageFromResponses({ input_tokens: 7, output_tokens: 3 }))
    .toEqual({ promptTokens: 7, completionTokens: 3, cachedTokens: null, reasoningTokens: null })
})

test('returns null when the provider reported no usage at all', () => {
  expect(usageFromResponses(null)).toBeNull()
})
