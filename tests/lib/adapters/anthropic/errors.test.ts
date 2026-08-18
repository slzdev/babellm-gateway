import { expect, test } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { toProviderError } from '@/lib/adapters/anthropic/errors'
import { ProviderError } from '@/lib/gateway/errors'

function apiError(status: number, message = 'boom') {
  return new Anthropic.APIError(status, { error: { message } }, message, undefined)
}

test('a 429 is retryable against another provider', () => {
  const err = toProviderError(apiError(429))
  expect(err).toBeInstanceOf(ProviderError)
  expect(err.status).toBe(429)
  expect(err.retryable).toBe(true)
})

test('a 400 is the request being wrong and is not retried elsewhere', () => {
  expect(toProviderError(apiError(400)).retryable).toBe(false)
})

test('a 404 carries the flavor hint, because a missing endpoint looks like this', () => {
  const err = toProviderError(apiError(404, 'not found'), 'set the flavor')
  expect(err.message).toBe('not found. set the flavor')
})

test('an abort becomes an upstream timeout', () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const err = toProviderError(abort)
  expect(err.status).toBe(504)
  expect(err.code).toBe('upstream_timeout')
})
