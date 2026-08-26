import OpenAI from 'openai'

export interface GatewayErrorInit {
  status: number
  type: string
  message: string
  code?: string | null
  param?: string | null
}

export class GatewayError extends Error {
  readonly status: number
  readonly type: string
  readonly code: string | null
  readonly param: string | null

  constructor(init: GatewayErrorInit) {
    super(init.message)
    this.name = 'GatewayError'
    this.status = init.status
    this.type = init.type
    this.code = init.code ?? null
    this.param = init.param ?? null
  }
}

export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedOperationError'
  }
}

export interface ProviderErrorInit {
  status: number
  message: string
  code?: string | null
  type?: string
  retryable: boolean
}

/**
 * A provider failure that has already been interpreted by the adapter that
 * produced it. Adapters throw this instead of their SDK's own error class,
 * because only the adapter knows which of its provider's statuses are worth
 * retrying — a fact the failover loop cannot rederive from an HTTP status.
 */
export class ProviderError extends Error {
  readonly status: number
  readonly code: string | null
  readonly type: string
  readonly retryable: boolean

  constructor(init: ProviderErrorInit) {
    super(init.message)
    this.name = 'ProviderError'
    this.status = init.status
    this.code = init.code ?? null
    this.type = init.type ?? (init.retryable ? 'api_error' : 'invalid_request_error')
    this.retryable = init.retryable
  }
}

export interface ClassifiedError {
  retryable: boolean
  status: number
  type: string
  code: string | null
  message: string
  /**
   * The request field the error is about, for the branches that know one.
   *
   * Only a GatewayError carries this: it is the gateway's own verdict on the
   * client's request, so it can name the field it refused. Every other branch
   * reports null — a provider failure or an SDK error is not about one of our
   * request fields, and inventing a `param` for it would be worse than
   * omitting one.
   *
   * It exists here because a refusal thrown by an adapter travels out through
   * `routed()` and `RoutedError`, and without this field it arrived at the
   * client with `param: null` — so the same refusal named its field when the
   * schema caught it (parseWith sets `param`) and did not when a target raised
   * it. `response_format` and `file` are exactly the fields transcription's
   * 400s are about, which makes that half of the answer worth carrying.
   */
  param: string | null
}

// Kept in step with the per-adapter sets in `adapters/*/errors.ts`; see the
// comment there for why each status earns another target.
const RETRYABLE_STATUSES = new Set([408, 409, 429, 498])

export function classifyProviderError(err: unknown): ClassifiedError {
  // Already interpreted by its adapter. Everything below this line is the
  // fallback for errors that escaped an adapter unwrapped.
  if (err instanceof ProviderError) {
    return {
      retryable: err.retryable,
      status: err.status,
      type: err.type,
      code: err.code,
      message: err.message,
      param: null,
    }
  }

  // A GatewayError is the gateway's own verdict that the client's request is
  // wrong, reached before any upstream call was made — e.g.
  // assertTranscribable refusing a timestamped response_format or an
  // oversized file (transcription-to-gemini.ts), thrown deliberately outside
  // an adapter's own try/catch so it arrives here, at the routing loop's
  // classifier, unwrapped. Always non-retryable regardless of `status`: no
  // upstream attempt happened, so there is nothing a retry against the same
  // or a different target could fix, and falling through to the generic
  // branch below would otherwise discard the gateway's own status/type/code
  // and answer with a fabricated retryable 502 — sending the same doomed
  // request to the next target and charging a target's circuit breaker for
  // a call it never received.
  if (err instanceof GatewayError) {
    return {
      retryable: false,
      status: err.status,
      type: err.type,
      code: err.code,
      message: err.message,
      param: err.param,
    }
  }

  if (err instanceof UnsupportedOperationError) {
    return {
      retryable: false,
      status: 501,
      type: 'invalid_request_error',
      code: 'unsupported_operation',
      message: err.message,
      param: null,
    }
  }

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return {
      retryable,
      status: status ?? 502,
      type: err.type ?? (retryable ? 'api_error' : 'invalid_request_error'),
      code: err.code ?? null,
      message: err.message,
      param: null,
    }
  }

  const isAbort =
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')

  return {
    retryable: true,
    status: isAbort ? 504 : 502,
    type: 'api_error',
    code: isAbort ? 'upstream_timeout' : 'upstream_error',
    message: err instanceof Error ? err.message : 'Upstream request failed',
    param: null,
  }
}

/**
 * A gateway error that also carries the attempt chain that produced it, so a
 * failed request can still report which providers were tried and why. The
 * attempt shape is structural rather than imported, to keep errors.ts free of
 * a dependency on the routing loop.
 */
export interface AttemptSummary {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  error?: string
}

export class RoutedError extends GatewayError {
  readonly attempts: AttemptSummary[]
  readonly lastProvider: string | null

  constructor(init: GatewayErrorInit & { attempts: AttemptSummary[]; lastProvider?: string | null }) {
    super(init)
    this.name = 'RoutedError'
    this.attempts = init.attempts
    this.lastProvider = init.lastProvider ?? null
  }
}

export function errorBody(err: unknown) {
  if (err instanceof GatewayError) {
    return {
      error: { message: err.message, type: err.type, param: err.param, code: err.code },
    }
  }
  return {
    error: {
      message: 'The gateway encountered an internal error.',
      type: 'internal_error',
      param: null,
      code: null,
    },
  }
}

export function errorResponse(err: unknown, extraHeaders?: HeadersInit): Response {
  const status = err instanceof GatewayError ? err.status : 500
  if (!(err instanceof GatewayError)) {
    // extraHeaders carries x-request-id whenever the caller has one (every
    // gateway route does), which is the only thing that lets this log line
    // be joined back to the response a client is complaining about.
    const requestId = extraHeaders ? new Headers(extraHeaders).get('x-request-id') : null
    console.error(
      `[gateway] unhandled error${requestId ? ` request_id=${requestId}` : ''}`,
      err,
    )
  }
  return Response.json(errorBody(err), { status, headers: extraHeaders })
}
