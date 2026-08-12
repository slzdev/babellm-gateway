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

export interface ClassifiedError {
  retryable: boolean
  status: number
  type: string
  code: string | null
  message: string
}

const RETRYABLE_STATUSES = new Set([408, 409, 429])

export function classifyProviderError(err: unknown): ClassifiedError {
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
  if (!(err instanceof GatewayError)) console.error('[gateway] unhandled error', err)
  return Response.json(errorBody(err), { status, headers: extraHeaders })
}
