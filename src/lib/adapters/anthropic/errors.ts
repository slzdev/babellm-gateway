import Anthropic from '@anthropic-ai/sdk'
import { ProviderError } from '@/lib/gateway/errors'

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
 * `APIError#message` is not the provider's own text: unlike the OpenAI SDK,
 * which unwraps the response body before handing it to the constructor, this
 * SDK's `.generate()` passes the whole body through and `makeMessage` falls
 * back to `"<status> " + JSON.stringify(wholeBody)` whenever the body has no
 * top-level `.message` — which a real Anthropic error body never does, its
 * text sits at `.error.message`. `err.error` is that raw body, so it is read
 * directly rather than trusting the SDK's own `.message`.
 */
function messageOf(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined
  const text = body?.error?.message
  return typeof text === 'string' ? text : err.message
}

/**
 * Interprets an Anthropic SDK failure so the routing loop does not have to.
 * This is the Anthropic counterpart to `adapters/openai/errors.ts`, and
 * separate from it for the reason that file gives: only the adapter knows
 * which of its provider's statuses are worth retrying.
 */
export function toProviderError(err: unknown, hint?: string): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof Anthropic.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    const message = messageOf(err)
    return new ProviderError({
      status: status ?? 502,
      // Anthropic's error body carries no `code` the way OpenAI's does — only
      // `type` (e.g. "rate_limit_error", "not_found_error"), which the SDK
      // parses from the body itself. `err.name` is not that field: every
      // instance, across every subclass, inherits the literal string
      // 'Error' from the base `Error` class, so it carries no information.
      code: null,
      ...(err.type ? { type: err.type } : {}),
      // A 404 from an Anthropic-shaped endpoint usually means the endpoint
      // itself is absent rather than the model, which is the single most
      // likely configuration mistake this gateway produces. The caller
      // supplies the instruction; only the status decides whether it is
      // relevant.
      message: status === 404 && hint ? `${message}. ${hint}` : message,
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
