import { expect, test } from 'vitest'
import {
  usageFromEmbeddings, usageFromResponses, usageFromTranscription,
} from '@/lib/gateway/usage'

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

test('normalizes token-billed transcription usage', () => {
  expect(usageFromTranscription({
    type: 'tokens', input_tokens: 14, output_tokens: 6, total_tokens: 20,
    input_token_details: { audio_tokens: 10, text_tokens: 4 },
  })).toEqual({ promptTokens: 14, completionTokens: 6, cachedTokens: null, reasoningTokens: null })
})

test('reports no usage for duration-billed transcription, rather than zero tokens', () => {
  // `seconds` measures audio, not tokens. Squeezing it into promptTokens would
  // corrupt every rollup that sums tokens (design doc §3.8), and reporting
  // zeroes would render real, unpriced spend as free.
  expect(usageFromTranscription({ type: 'duration', seconds: 12.5 })).toBeNull()
})

test('returns null when a transcription reported no usage at all', () => {
  expect(usageFromTranscription(null)).toBeNull()
  expect(usageFromTranscription(undefined)).toBeNull()
  // A `text`/`srt`/`vtt` response is a bare string, so there is no usage
  // object to read — and a clone that sends an unrecognized variant is not
  // guessed at either.
  expect(usageFromTranscription('WEBVTT')).toBeNull()
  expect(usageFromTranscription({ seconds: 12.5 })).toBeNull()
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
