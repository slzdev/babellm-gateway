import { expect, test } from 'vitest'
import { ApiError } from '@google/genai'
import { toProviderError } from '@/lib/adapters/gemini/errors'
import { GatewayError, ProviderError } from '@/lib/gateway/errors'

test.each([408, 409, 429, 498, 500, 502, 503, 504])('status %s maps to retryable', (status) => {
  expect(toProviderError(new ApiError({ message: 'boom', status })).retryable).toBe(true)
})

test.each([400, 401, 403, 404, 413, 422])('status %s maps to fatal', (status) => {
  expect(toProviderError(new ApiError({ message: 'boom', status })).retryable).toBe(false)
})

test('a 404 gains a hint about Gemini model ids', () => {
  const mapped = toProviderError(new ApiError({ message: 'model not found', status: 404 }))
  expect(mapped.message).toContain('model not found')
  expect(mapped.message).toContain('gemini-2.5-flash')
})

test('a non-404 keeps its message unchanged', () => {
  expect(toProviderError(new ApiError({ message: 'bad request', status: 400 })).message)
    .toBe('bad request')
})

test('an abort maps to a retryable 504 upstream_timeout', () => {
  const mapped = toProviderError(new DOMException('aborted', 'AbortError'))
  expect(mapped.status).toBe(504)
  expect(mapped.code).toBe('upstream_timeout')
  expect(mapped.retryable).toBe(true)
})

test('an unrecognised failure is a retryable 502', () => {
  const mapped = toProviderError(new Error('socket hang up'))
  expect(mapped.status).toBe(502)
  expect(mapped.code).toBe('upstream_error')
  expect(mapped.retryable).toBe(true)
})

test('an already-classified ProviderError passes through untouched', () => {
  const original = new ProviderError({ status: 429, message: 'slow down', retryable: true })
  expect(toProviderError(original)).toBe(original)
})

test('a GatewayError is rethrown untouched, never reclassified as a retryable ProviderError', () => {
  // The case this guards: assertTranscribable (transcription-to-gemini.ts)
  // throws a 400 GatewayError for a refused response_format or an oversized
  // file, called from inside the adapter's transcribe(). Today that call
  // sits outside its own try block, so this classifier never actually sees
  // one — but the guard belongs here regardless, so a future call site that
  // throws a GatewayError from inside a try is already safe without having
  // to remember this rule itself. Without it, a GatewayError would fall
  // through to the generic branch below and come back as a retryable 502
  // upstream_error — exactly the conflation transcribe() is written to avoid.
  const original = new GatewayError({
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_media',
    param: 'file',
    message: 'could not determine the media type',
  })

  let thrown: unknown
  try {
    toProviderError(original)
  } catch (err) {
    thrown = err
  }

  expect(thrown).toBe(original)
  expect(thrown).not.toBeInstanceOf(ProviderError)
})
