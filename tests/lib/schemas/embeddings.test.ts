import { expect, test } from 'vitest'
import { embeddingsRequestSchema } from '@/lib/schemas/embeddings'

test('accepts a single string input', () => {
  const parsed = embeddingsRequestSchema.parse({ model: 'house-embed', input: 'hello' })
  expect(parsed.input).toBe('hello')
})

test('accepts an array of strings', () => {
  const parsed = embeddingsRequestSchema.parse({ model: 'm', input: ['hello', 'world'] })
  expect(parsed.input).toEqual(['hello', 'world'])
})

test('accepts a single token array', () => {
  const parsed = embeddingsRequestSchema.parse({ model: 'm', input: [15339, 1917] })
  expect(parsed.input).toEqual([15339, 1917])
})

test('accepts an array of token arrays', () => {
  const parsed = embeddingsRequestSchema.parse({ model: 'm', input: [[15339], [1917, 0]] })
  expect(parsed.input).toEqual([[15339], [1917, 0]])
})

test('accepts an empty string input', () => {
  // OpenAI documents an empty string as invalid and rejects it upstream. The
  // gateway does not duplicate that validation: the upstream is the authority
  // on what it can embed, and its 400 is more accurate than a guess made here
  // (the same reasoning that leaves catalog `kind` unenforced). Routing an
  // empty string is unambiguous, so nothing downstream needs it refused.
  const parsed = embeddingsRequestSchema.parse({ model: 'm', input: '' })
  expect(parsed.input).toBe('')
})

test('rejects an empty array input', () => {
  // Not upstream validation, which is why this one is refused while the empty
  // string above is not: `[]` satisfies string[], number[] and number[][] at
  // once, so the gateway cannot tell which of the four shapes the client
  // meant — and that discrimination is what decides whether a target can serve
  // the request at all (a token array is refused on Gemini).
  expect(embeddingsRequestSchema.safeParse({ model: 'm', input: [] }).success).toBe(false)
})

test('rejects an array of empty token arrays', () => {
  expect(embeddingsRequestSchema.safeParse({ model: 'm', input: [[]] }).success).toBe(false)
})

test('requires a model', () => {
  expect(embeddingsRequestSchema.safeParse({ input: 'hello' }).success).toBe(false)
  expect(embeddingsRequestSchema.safeParse({ model: '', input: 'hello' }).success).toBe(false)
})

test('requires an input', () => {
  expect(embeddingsRequestSchema.safeParse({ model: 'm' }).success).toBe(false)
})

test('accepts both encoding formats', () => {
  for (const encoding_format of ['float', 'base64'] as const) {
    const parsed = embeddingsRequestSchema.parse({ model: 'm', input: 'hi', encoding_format })
    expect(parsed.encoding_format).toBe(encoding_format)
  }
})

test('rejects an unrecognized encoding_format', () => {
  // The one parameter the adapter must understand rather than forward blindly:
  // it decides what the OpenAI SDK does to the response body, so a value the
  // gateway cannot reason about is refused instead of passed through.
  expect(
    embeddingsRequestSchema.safeParse({ model: 'm', input: 'hi', encoding_format: 'binary' }).success,
  ).toBe(false)
})

test('rejects a non-positive dimensions', () => {
  for (const dimensions of [0, -1, 1.5]) {
    expect(embeddingsRequestSchema.safeParse({ model: 'm', input: 'hi', dimensions }).success).toBe(false)
  }
  expect(embeddingsRequestSchema.parse({ model: 'm', input: 'hi', dimensions: 512 }).dimensions).toBe(512)
})

test('preserves unknown provider-specific parameters', () => {
  // looseObject, as in the chat and responses schemas: a parameter this
  // gateway has never heard of must reach the upstream rather than be stripped
  // or refused on its way there.
  const parsed = embeddingsRequestSchema.parse({
    model: 'm',
    input: 'hi',
    input_type: 'query',
    truncate: 'END',
  }) as Record<string, unknown>
  expect(parsed.input_type).toBe('query')
  expect(parsed.truncate).toBe('END')
})

test('accepts user', () => {
  const parsed = embeddingsRequestSchema.parse({ model: 'm', input: 'hi', user: 'u-1' })
  expect(parsed.user).toBe('u-1')
})
