import OpenAI from 'openai'
import { ProviderError } from '@/lib/gateway/errors'

// 408 and 409 are transport-ish rather than a rejection of the request, and
// 429 is the one status where retrying against a *different* provider is
// exactly the right move. Everything else below 500 is the provider telling
// us the request itself is wrong, which another provider would only reject
// differently.
const RETRYABLE_STATUSES = new Set([408, 409, 429])

/**
 * Interprets an OpenAI SDK failure so the routing loop does not have to.
 * This is the file every future adapter writes its own version of; the
 * gateway's own classifier is only a fallback for errors that escape one.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status ?? 502,
      code: err.code ?? null,
      ...(err.type ? { type: err.type } : {}),
      message: err.message,
      retryable,
    })
  }

  // DOMException does not extend Error on every runtime this may run on, so
  // both checks are needed to catch an abort.
  const isAbort =
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')

  return new ProviderError({
    status: isAbort ? 504 : 502,
    code: isAbort ? 'upstream_timeout' : 'upstream_error',
    message: err instanceof Error ? err.message : 'Upstream request failed',
    retryable: true,
  })
}
