import { expect, test } from 'vitest'
import { ApiError } from '@google/genai'
import { toProviderError } from '@/lib/adapters/gemini/errors'
import { ProviderError } from '@/lib/gateway/errors'

test.each([408, 409, 429, 500, 502, 503, 504])('status %s maps to retryable', (status) => {
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
