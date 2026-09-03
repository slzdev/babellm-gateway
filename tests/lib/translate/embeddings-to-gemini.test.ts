import { expect, test } from 'vitest'
import {
  droppedParams,
  fromEmbedContent,
  toBase64,
  toEmbedParams,
} from '@/lib/translate/embeddings-to-gemini'
import { ProviderError } from '@/lib/gateway/errors'
import type { AttemptContext } from '@/lib/adapters/types'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'

const ctx: AttemptContext = {
  upstreamModel: 'gemini-embedding-001',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

function request(overrides: Partial<EmbeddingsRequest> = {}): EmbeddingsRequest {
  return { model: 'virtual', input: 'hello', ...overrides }
}

test('a string input becomes a one-element contents array', () => {
  const params = toEmbedParams(request({ input: 'hello' }), ctx, 'gemini-prod')

  expect(params.model).toBe('gemini-embedding-001')
  expect(params.contents).toEqual(['hello'])
})

test('a string array is carried through in order', () => {
  const params = toEmbedParams(request({ input: ['one', 'two', 'three'] }), ctx, 'gemini-prod')

  expect(params.contents).toEqual(['one', 'two', 'three'])
})

test('dimensions becomes outputDimensionality', () => {
  const params = toEmbedParams(request({ dimensions: 512 }), ctx, 'gemini-prod')

  expect(params.config?.outputDimensionality).toBe(512)
})

test('an absent dimensions sends no outputDimensionality key', () => {
  const params = toEmbedParams(request(), ctx, 'gemini-prod')

  expect(params.config).not.toHaveProperty('outputDimensionality')
})

test('the abort signal is carried on the config', () => {
  const params = toEmbedParams(request(), ctx, 'gemini-prod')

  expect(params.config?.abortSignal).toBe(ctx.signal)
})

test('a token-id array is refused, not dropped', () => {
  const attempt = () => toEmbedParams(request({ input: [1, 2, 3] }), ctx, 'gemini-prod')

  expect(attempt).toThrow(ProviderError)
  try {
    attempt()
  } catch (err) {
    const error = err as ProviderError
    expect(error.status).toBe(400)
    expect(error.code).toBe('unsupported_input')
    expect(error.type).toBe('invalid_request_error')
    // Non-retryable: every Gemini target in the chain would refuse this the
    // same way, and a retryable failure would also mark a healthy target down.
    expect(error.retryable).toBe(false)
    // The provider is named because that is where the fix is.
    expect(error.message).toContain('gemini-prod')
  }
})

test('a nested token-id array is refused too', () => {
  expect(() => toEmbedParams(request({ input: [[1, 2], [3, 4]] }), ctx, 'gemini-prod'))
    .toThrow(ProviderError)
})

test('embeddings come back in request order, indexed by position', () => {
  const res = { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }

  const result = fromEmbedContent(res, request({ input: ['a', 'b'] }), 'gemini-embedding-001')

  expect(result.object).toBe('list')
  expect(result.model).toBe('gemini-embedding-001')
  expect(result.data).toEqual([
    { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
    { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
  ])
})

test('no usage key is emitted at all', () => {
  const res = { embeddings: [{ values: [0.1] }] }

  const result = fromEmbedContent(res, request(), 'gemini-embedding-001')

  // Not a zeroed usage object: the Developer API measures nothing for
  // embedContent, and a fabricated count would claim a measurement that never
  // happened. usageFromEmbeddings reads the absence as unpriced.
  expect(result).not.toHaveProperty('usage')
})

test('a base64 request gets base64 strings that round-trip to the floats', () => {
  const values = [0.1, -0.2, 3.5, 0]
  const res = { embeddings: [{ values }] }

  const result = fromEmbedContent(
    res,
    request({ encoding_format: 'base64' }),
    'gemini-embedding-001',
  )

  const encoded = result.data[0].embedding as unknown as string
  expect(typeof encoded).toBe('string')

  const bytes = Buffer.from(encoded, 'base64')
  expect(bytes.byteLength).toBe(values.length * 4)

  const decoded = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  // toBeCloseTo, not toEqual: 0.1 and -0.2 are not representable as float32, so
  // encoding a double and decoding it back necessarily loses precision. These
  // are the same bytes OpenAI puts on the wire, and its clients decode them the
  // same lossy way.
  expect(decoded).toHaveLength(values.length)
  for (const [index, value] of values.entries()) {
    expect(decoded[index]).toBeCloseTo(value, 6)
  }
})

test('the encoder writes little-endian float32', () => {
  // 1.0 as an IEEE-754 single is 0x3F800000, which little-endian puts on the
  // wire as 00 00 80 3F.
  expect([...Buffer.from(toBase64([1]), 'base64')]).toEqual([0x00, 0x00, 0x80, 0x3f])
})

test('a float request leaves the vectors as numbers', () => {
  const result = fromEmbedContent({ embeddings: [{ values: [0.1] }] }, request(), 'm')

  expect(result.data[0].embedding).toEqual([0.1])
})

test('a missing embeddings array is an upstream failure', () => {
  const attempt = () => fromEmbedContent({}, request(), 'm')

  expect(attempt).toThrow(ProviderError)
  try {
    attempt()
  } catch (err) {
    const error = err as ProviderError
    expect(error.status).toBe(502)
    expect(error.code).toBe('upstream_error')
    // Retryable: nothing about the request was rejected, so a sibling target
    // can still serve it.
    expect(error.retryable).toBe(true)
  }
})

test('an empty embeddings array throws rather than returning an empty list', () => {
  expect(() => fromEmbedContent({ embeddings: [] }, request(), 'm')).toThrow(ProviderError)
})

test('fewer embeddings than inputs throws rather than shifting the indices', () => {
  expect(() =>
    fromEmbedContent({ embeddings: [{ values: [0.1] }] }, request({ input: ['a', 'b'] }), 'm'),
  ).toThrow(/expected 2, got 1/)
})

test('an entry with no values throws rather than becoming an empty vector', () => {
  expect(() =>
    fromEmbedContent({ embeddings: [{ values: [0.1] }, {}] }, request({ input: ['a', 'b'] }), 'm'),
  ).toThrow(/embedding 1 carries no values/)
})

test('user is reported as dropped', () => {
  expect(droppedParams(request({ user: 'u-1' }))).toEqual(['user'])
})

test('nothing is dropped for a request Gemini can serve whole', () => {
  expect(droppedParams(request({ dimensions: 256, encoding_format: 'base64' }))).toEqual([])
})
