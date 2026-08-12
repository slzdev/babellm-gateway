import { expect, test } from 'vitest'
import { canonicalKeyCandidates } from '@/lib/catalog/normalize'

test('openai ids are namespaced as-is', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o')).toEqual(['openai/gpt-4o'])
})

test('a dated openai snapshot falls back to its undated id', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o-2024-08-06')).toEqual([
    'openai/gpt-4o-2024-08-06',
    'openai/gpt-4o',
  ])
})

test('gemini ids drop the models/ prefix', () => {
  expect(canonicalKeyCandidates('gemini', 'models/gemini-flash-latest')).toEqual([
    'google/models/gemini-flash-latest',
    'google/gemini-flash-latest',
  ])
})

test('a regioned bedrock id is tried as-is first, then unregioned', () => {
  // models.dev stores bedrock ids verbatim, region prefix and -v1:0 included.
  expect(canonicalKeyCandidates('bedrock', 'us.deepseek.r1-v1:0')).toEqual([
    'amazon-bedrock/us.deepseek.r1-v1:0',
    'amazon-bedrock/deepseek.r1-v1:0',
  ])
})

test('an unregioned bedrock id tries the known region prefixes', () => {
  expect(canonicalKeyCandidates('bedrock', 'anthropic.claude-opus-4-5-20251101-v1:0')).toEqual([
    'amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/eu.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/apac.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/global.anthropic.claude-opus-4-5-20251101-v1:0',
  ])
})

test('a vendor segment that is not a known region is left alone', () => {
  // 'ap' is not a Bedrock region prefix — only us/eu/apac/global are.
  expect(canonicalKeyCandidates('bedrock', 'ap.something.model-v1:0')).toEqual([
    'amazon-bedrock/ap.something.model-v1:0',
    'amazon-bedrock/us.ap.something.model-v1:0',
    'amazon-bedrock/eu.ap.something.model-v1:0',
    'amazon-bedrock/apac.ap.something.model-v1:0',
    'amazon-bedrock/global.ap.something.model-v1:0',
  ])
})

test('openai_compatible with no namespace configured produces no candidates', () => {
  // ollama has no models.dev namespace at all, and the namespace cannot be
  // guessed from a base URL. Unmatched is the correct outcome.
  expect(canonicalKeyCandidates('openai_compatible', 'llama3.1:8b')).toEqual([])
})

test('a configured namespace is applied to openai_compatible ids', () => {
  expect(canonicalKeyCandidates('openai_compatible', 'llama-3.3-70b', 'groq')).toEqual([
    'groq/llama-3.3-70b',
  ])
})

test('a slash-bearing openai_compatible id is also tried verbatim', () => {
  // OpenRouter-style ids already carry a vendor segment.
  expect(canonicalKeyCandidates('openai_compatible', 'openai/gpt-4o', 'openrouter')).toEqual([
    'openrouter/openai/gpt-4o',
    'openai/gpt-4o',
  ])
})

test('a configured namespace overrides the adapter default', () => {
  expect(canonicalKeyCandidates('gemini', 'gemini-2.5-pro', 'google-vertex')).toEqual([
    'google-vertex/gemini-2.5-pro',
  ])
})

test('a blank namespace is ignored rather than producing a bare slash', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o', '   ')).toEqual(['openai/gpt-4o'])
})

test('candidates are de-duplicated and order is stable', () => {
  const keys = canonicalKeyCandidates('openai', 'gpt-4o')
  expect(new Set(keys).size).toBe(keys.length)
})
