import { expect, test } from 'vitest'
import { toProviderError } from '@/lib/adapters/bedrock/errors'
import { GatewayError, ProviderError, UnsupportedOperationError } from '@/lib/gateway/errors'

test.each([
  ['ValidationException', 400, false], ['AccessDeniedException', 403, false], ['UnrecognizedClientException', 403, false],
  ['ResourceNotFoundException', 404, false], ['ThrottlingException', 429, true], ['ModelNotReadyException', 429, true],
  ['ModelTimeoutException', 408, true], ['ServiceUnavailableException', 503, true], ['InternalServerException', 500, true],
])('classifies %s without losing AWS diagnostics', (name, status, retryable) => {
  expect(toProviderError(Object.assign(new Error('actionable AWS message'), { name }))).toMatchObject({ code: name, status, retryable, message: 'actionable AWS message' })
})
test.each([[400, false], [429, true], [503, true]])('ModelErrorException uses original status %i to decide failover', (originalStatusCode, retryable) => {
  expect(toProviderError({ name: 'ModelErrorException', message: 'model failed', $metadata: { httpStatusCode: 424 }, originalStatusCode })).toMatchObject({ status: 424, code: 'ModelErrorException', retryable })
})
test('transport failures are retryable and existing typed errors retain identity', () => {
  expect(toProviderError(new Error('socket closed'))).toMatchObject({ status: 502, retryable: true })
  for (const error of [new ProviderError({ status: 502, message: 'bad', retryable: true }), new GatewayError({ status: 400, type: 'invalid_request_error', message: 'bad image', param: 'messages' }), new UnsupportedOperationError('unsupported')]) {
    if (error instanceof ProviderError) expect(toProviderError(error)).toBe(error)
    else expect(() => toProviderError(error)).toThrow(error)
  }
})

test('default AWS credential-chain configuration failure is nonretryable and preserves its actionable diagnostic', () => {
  const error = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' })
  expect(toProviderError(error)).toMatchObject({ status: 403, code: 'CredentialsProviderError', retryable: false,
    message: 'Could not load credentials from any providers' })
})
