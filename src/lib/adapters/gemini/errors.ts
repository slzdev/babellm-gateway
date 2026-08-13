import { ApiError } from '@google/genai'
import { ProviderError } from '@/lib/gateway/errors'

// The same three statuses the OpenAI classifier treats as worth another
// provider: transport-ish rather than a rejection of the request, plus the one
// status where retrying elsewhere is exactly right.
const RETRYABLE_STATUSES = new Set([408, 409, 429])

// A 404 from Gemini is a model id it does not recognise, which is the single
// most likely mistake here: ids move fast, and a catalog synced weeks ago can
// name one that no longer exists.
const MODEL_HINT =
  'Gemini model ids look like "gemini-2.5-flash" — check the id on the Catalog page, or re-sync this provider.'

/**
 * Interprets a Gemini SDK failure so the routing loop does not have to. The
 * Gemini counterpart to `adapters/openai/errors.ts`, and separate from it for
 * the reason that file gives: only the adapter knows which of its provider's
 * statuses are worth retrying.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof ApiError) {
    // `status` is typed non-optional and both SDK construction sites always
    // set it, so this guard is defensive against a status-less ApiError
    // rather than a runtime case the SDK is known to produce.
    const status = err.status
    const retryable = !status || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status || 502,
      code: null,
      message: status === 404 ? `${err.message}. ${MODEL_HINT}` : err.message,
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
