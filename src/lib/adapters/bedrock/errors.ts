import { GatewayError, ProviderError, UnsupportedOperationError } from '@/lib/gateway/errors'

const STATUSES: Record<string, number> = {
  ValidationException: 400, AccessDeniedException: 403, UnrecognizedClientException: 403,
  InvalidSignatureException: 403, ExpiredTokenException: 403, ResourceNotFoundException: 404,
  ThrottlingException: 429, ModelNotReadyException: 429, ModelTimeoutException: 408,
  ServiceUnavailableException: 503, InternalServerException: 500, ModelErrorException: 424,
  ServiceQuotaExceededException: 400,
}
const TRANSIENT = new Set([408, 409, 429])

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  // Preserve the gateway's parameter-specific client errors and 501 refusals.
  if (err instanceof GatewayError || err instanceof UnsupportedOperationError) throw err
  const error = err && typeof err === 'object' ? err as {
    name?: string; message?: string; $metadata?: { httpStatusCode?: number }; originalStatusCode?: number
  } : {}
  const name = error.name ?? 'upstream_error'
  const timeout = name === 'AbortError' || name === 'TimeoutError'
  const status = error.$metadata?.httpStatusCode ?? STATUSES[name] ?? (timeout ? 504 : 502)
  const effectiveStatus = name === 'ModelErrorException' ? error.originalStatusCode : status
  const retryable = effectiveStatus === undefined || TRANSIENT.has(effectiveStatus) || effectiveStatus >= 500
  return new ProviderError({
    status, code: timeout ? 'upstream_timeout' : name,
    message: error.message ?? 'Bedrock request failed',
    retryable,
  })
}
