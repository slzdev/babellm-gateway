import { expect, test } from 'vitest'
import OpenAI from 'openai'
import { toProviderError } from '@/lib/adapters/openai/errors'
import { ProviderError } from '@/lib/gateway/errors'

// `OpenAI.APIError`'s constructor is `(status, error, message, headers)` where
// `error` is the already-unwrapped error body — see `APIError.generate()` in
// openai/src/core/error.ts, which does `errorResponse?.['error']` first.
function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

test.each([408, 409, 429, 500, 502, 503, 504])('status %s maps to retryable', (status) => {
  expect(toProviderError(apiError(status)).retryable).toBe(true)
})

test.each([400, 401, 403, 404, 413, 422, 499])('status %s maps to fatal', (status) => {
  expect(toProviderError(apiError(status)).retryable).toBe(false)
})

test('a connection error with no status is retryable as a 502', () => {
  const mapped = toProviderError(new OpenAI.APIConnectionError({}))
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(502)
})

test('an abort maps to a retryable 504 upstream_timeout', () => {
  const mapped = toProviderError(new DOMException('aborted', 'AbortError'))
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(504)
  expect(mapped.code).toBe('upstream_timeout')
})

test('the upstream status, code and message survive the mapping', () => {
  const mapped = toProviderError(apiError(400, 'context_length_exceeded'))
  expect(mapped).toBeInstanceOf(ProviderError)
  expect(mapped.status).toBe(400)
  expect(mapped.code).toBe('x')
  expect(mapped.message).toContain('context_length_exceeded')
})

test('an unknown throwable becomes a retryable 502 rather than being swallowed', () => {
  const mapped = toProviderError('a string, somehow')
  expect(mapped.retryable).toBe(true)
  expect(mapped.status).toBe(502)
  expect(mapped.code).toBe('upstream_error')
})

test('an already-mapped ProviderError passes through untouched', () => {
  const original = new ProviderError({ status: 429, message: 'slow down', retryable: true })
  expect(toProviderError(original)).toBe(original)
})
