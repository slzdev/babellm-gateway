import { expect, test } from 'vitest'
import { usageFromEmbeddings, usageFromResponses } from '@/lib/gateway/usage'

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

test('embeddings usage measures zero output tokens rather than leaving them null', () => {
  // The one place a normalizer invents a number: null would say "unmeasured",
  // which would make an otherwise fully-measured request unpriceable.
  expect(usageFromEmbeddings({ prompt_tokens: 4, total_tokens: 4 }))
    .toEqual({ promptTokens: 4, completionTokens: 0, cachedTokens: null, reasoningTokens: null })
})

test('embeddings usage leaves an absent prompt count unmeasured', () => {
  expect(usageFromEmbeddings({ total_tokens: 4 }))
    .toEqual({ promptTokens: null, completionTokens: 0, cachedTokens: null, reasoningTokens: null })
})

test('returns null when the provider reported no embeddings usage at all', () => {
  // Gemini's embedContent measures nothing, so the response carries no usage
  // object — unpriced, not free.
  expect(usageFromEmbeddings(null)).toBeNull()
  expect(usageFromEmbeddings(undefined)).toBeNull()
})
