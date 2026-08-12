import { afterEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import {
  GatewayError,
  ProviderError,
  UnsupportedOperationError,
  classifyProviderError,
  errorResponse,
} from '@/lib/gateway/errors'

// `OpenAI.APIError`'s constructor is `(status, error, message, headers)` where
// `error` is the *already-unwrapped* error body (i.e. what a real response's
// `.error` field holds) — see openai/src/core/error.ts `APIError.generate()`,
// which does `const error = errorResponse?.['error']` before calling the
// constructor. Pass the unwrapped shape directly so `err.code` etc. reflect
// what a genuine SDK-thrown error would carry.
function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

test('errorResponse renders the OpenAI envelope', async () => {
  const res = errorResponse(
    new GatewayError({ status: 404, type: 'invalid_request_error', code: 'model_not_found', message: 'no such model' }),
  )
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({
    error: { message: 'no such model', type: 'invalid_request_error', param: null, code: 'model_not_found' },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('errorResponse maps an unknown error to a 500 without leaking details', async () => {
  // errorResponse deliberately logs unexpected errors server-side; spy on it
  // so that expected log stays out of the pristine test run's output.
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const res = errorResponse(new Error('connection string postgres://user:pw@host'))
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body.error.type).toBe('internal_error')
  expect(body.error.message).not.toContain('postgres://')
  expect(consoleError).toHaveBeenCalled()
})

test.each([undefined, 408, 409, 429, 500, 502, 503, 504])(
  'status %s is retryable',
  (status) => {
    const err = status === undefined ? new OpenAI.APIConnectionError({}) : apiError(status)
    expect(classifyProviderError(err).retryable).toBe(true)
  },
)

test.each([400, 401, 403, 404, 413, 422])('status %s is fatal', (status) => {
  expect(classifyProviderError(apiError(status)).retryable).toBe(false)
})

test('classification preserves the upstream message and status', () => {
  const classified = classifyProviderError(apiError(400, 'context_length_exceeded'))
  expect(classified.status).toBe(400)
  expect(classified.message).toContain('context_length_exceeded')
})

test('an UnsupportedOperationError is fatal with status 501', () => {
  const classified = classifyProviderError(
    new UnsupportedOperationError('embeddings not supported by this provider'),
  )
  expect(classified.retryable).toBe(false)
  expect(classified.status).toBe(501)
})

test('an abort is classified as retryable', () => {
  const err = new DOMException('aborted', 'AbortError')
  expect(classifyProviderError(err).retryable).toBe(true)
})

test('a ProviderError classifies as itself, without re-deriving anything', () => {
  const classified = classifyProviderError(
    new ProviderError({
      status: 400,
      code: 'invalid_argument',
      type: 'invalid_request_error',
      message: 'tools[0].parameters is not valid',
      retryable: false,
    }),
  )

  expect(classified).toEqual({
    retryable: false,
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_argument',
    message: 'tools[0].parameters is not valid',
  })
})

test('a retryable ProviderError stays retryable even at a 4xx status', () => {
  // The whole point of moving classification into the adapter: only the
  // adapter knows that this provider's 400 means "overloaded, try again".
  const classified = classifyProviderError(
    new ProviderError({ status: 400, message: 'overloaded', retryable: true }),
  )

  expect(classified.retryable).toBe(true)
  expect(classified.status).toBe(400)
})

test('a ProviderError defaults its type from retryability', () => {
  expect(new ProviderError({ status: 503, message: 'x', retryable: true }).type)
    .toBe('api_error')
  expect(new ProviderError({ status: 400, message: 'x', retryable: false }).type)
    .toBe('invalid_request_error')
})
