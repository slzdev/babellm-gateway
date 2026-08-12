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
}

const RETRYABLE_STATUSES = new Set([408, 409, 429])

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
    }
  }

  if (err instanceof UnsupportedOperationError) {
    return {
      retryable: false,
      status: 501,
      type: 'invalid_request_error',
      code: 'unsupported_operation',
      message: err.message,
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
