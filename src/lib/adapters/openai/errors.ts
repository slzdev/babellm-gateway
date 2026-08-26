import OpenAI from 'openai'
import { GatewayError, ProviderError } from '@/lib/gateway/errors'

// 408 and 409 are transport-ish rather than a rejection of the request, and
// 429 is the one status where retrying against a *different* provider is
// exactly the right move. 498 is non-standard, and OpenAI-compatible stacks
// that emit it mean an expired or invalid token — this target's credential
// problem rather than the request's, so a sibling target holding its own key
// is worth trying. Everything else below 500 is the provider telling us the
// request itself is wrong, which another provider would only reject
// differently.
const RETRYABLE_STATUSES = new Set([408, 409, 429, 498])

/**
 * Interprets an OpenAI SDK failure so the routing loop does not have to.
 * This is the file every future adapter writes its own version of; the
 * gateway's own classifier is only a fallback for errors that escape one.
 *
 * A `GatewayError` is rethrown, never reclassified: it is the gateway's own
 * verdict that the client's request is wrong, made before any upstream call
 * happened, and the generic branch below would otherwise turn it into a
 * retryable 502 `upstream_error` — resending a doomed request and charging a
 * healthy provider's circuit breaker for a call it never received. Nothing
 * in this adapter's try blocks throws a `GatewayError` today, but the guard
 * belongs here rather than at each call site so the next one that does is
 * already safe — see the Gemini counterpart of this file, which does throw
 * one from inside a try block (an unresolvable audio mime type).
 */
export function toProviderError(err: unknown, hint?: string): ProviderError {
  if (err instanceof GatewayError) throw err
  if (err instanceof ProviderError) return err

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status ?? 502,
      code: err.code ?? null,
      ...(err.type ? { type: err.type } : {}),
      // A 404 from an OpenAI-shaped endpoint usually means the endpoint itself
      // is absent rather than the model, which is the single most likely
      // configuration mistake this gateway produces. The caller supplies the
      // instruction; only the status decides whether it is relevant.
      message: status === 404 && hint ? `${err.message}. ${hint}` : err.message,
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
