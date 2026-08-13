import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter, resolveApiFlavor } from '@/lib/adapters/registry'
import type { ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { chatCompletionRequestSchema, type ChatCompletionRequest } from '@/lib/schemas/chat'
import { droppedParams } from '@/lib/translate/chat-to-responses'
import { logRequest } from '@/lib/logs'
import type { LogPayload, LogUsage, RequestOutcome } from '@/lib/logs/types'
import { computeCost, priceFor } from '@/lib/pricing'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { GatewayError, RoutedError, errorResponse } from './errors'
import { execute, type AttemptRecord } from './execute'
import { newCompletionId, rewriteCompletion } from './identity'
import { resolveModel, type Candidate } from './resolve'
import { selectOrder } from './select'
import { sseResponse, startChatStream } from './sse'
import { usageFrom } from './usage'

export interface ChatHandlerDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
}

const defaultDeps: ChatHandlerDeps = { createAdapter: defaultCreateAdapter }

async function parseBody(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      message: 'Request body could not be parsed as JSON.',
    })
  }

  const result = chatCompletionRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = (result.error as z.ZodError).issues[0]
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param: issue.path.length > 0 ? String(issue.path[0]) : null,
      message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
    })
  }
  return result.data
}

/**
 * Which request parameters the winning target could not express. Computed here
 * rather than returned by the adapter: the alternative is a channel through
 * ProviderAdapter, which would put translation-specific knowledge into the
 * interface every future adapter implements.
 */
function droppedFor(candidate: Candidate, body: ChatCompletionRequest): string[] {
  return resolveApiFlavor(candidate.provider) === 'responses' ? droppedParams(body) : []
}

export function attemptHeaders(
  candidate: Candidate,
  requestId: string,
  dropped: string[] = [],
): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
    ...(dropped.length > 0 ? { 'x-babellm-dropped-params': dropped.join(',') } : {}),
  }
}

const ERROR_MESSAGE_MAX_LENGTH = 2000

/** The log keeps the real message even for an unhandled error: the page that
 * reads it is admin-only, and the sanitized envelope the client received is
 * useless for diagnosis. Length is still bounded — a provider that fails
 * with a multi-megabyte HTML body must not turn into a multi-megabyte row. */
function errorMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : message
}

function errorFields(err: unknown) {
  if (err === undefined) return {}
  if (err instanceof GatewayError) {
    return { errorType: err.type, errorCode: err.code, errorMessage: errorMessage(err.message) }
  }
  return {
    errorType: 'internal_error',
    errorCode: null,
    errorMessage: errorMessage(err instanceof Error ? err.message : String(err)),
  }
}

export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')
  const startedAt = Date.now()

  // Tracked outside the try so the log line can still say who was calling
  // and for what when the request never got as far as an attempt.
  let keyId: string | null = null
  let keyName: string | null = null
  let modelName: string | null = null
  let stream = false
  let dropped: string[] = []

  interface LogExtra {
    ttftMs?: number
    /** The target that actually served, which is what gets priced. */
    candidate?: Candidate
    usage?: LogUsage | null
    payload?: LogPayload | null
    error?: unknown
  }

  function log(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra = {},
  ) {
    // Fire-and-forget. A request that succeeded must not be failed — or even
    // slowed — by its own bookkeeping.
    void writeLog(status, outcome, attempts, extra).catch((err) =>
      console.error(`[gateway] failed to write request log request_id=${requestId}`, err),
    )
  }

  async function writeLog(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra,
  ) {
    const usage = extra.usage ?? null
    const cost =
      extra.candidate && usage
        ? computeCost(
            await priceFor(extra.candidate.provider.id, extra.candidate.upstreamModel),
            usage,
          )
        : null

    await logRequest({
      requestId,
      keyId,
      keyName,
      model: modelName,
      stream,
      status,
      outcome,
      ...errorFields(extra.error),
      latencyMs: Date.now() - startedAt,
      ...(extra.ttftMs === undefined ? {} : { ttftMs: extra.ttftMs }),
      attempts,
      final: extra.candidate
        ? {
            targetId: extra.candidate.targetId,
            providerId: extra.candidate.provider.id,
            provider: extra.candidate.provider.name,
            upstreamModel: extra.candidate.upstreamModel,
          }
        : null,
      usage,
      cost,
      ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
      payload: extra.payload ?? null,
    })
  }

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    keyId = apiKey.id
    keyName = apiKey.name
    const body = await parseBody(request)
    modelName = body.model
    stream = body.stream === true

    const { model, candidates } = await resolveModel(body.model)
    const chain = selectOrder(candidates, model)

    void touchApiKey(apiKey.id).catch((err) =>
      console.error(`[gateway] failed to update last_used_at request_id=${requestId}`, err),
    )

    const identity = { id: newCompletionId(), model: body.model }

    if (stream) {
      // startChatStream pulls the first chunk, so a failure inside `run` is
      // still a failure before the response is committed — which is what
      // makes failover safe for streams.
      const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
        startChatStream(adapter.chatStream(body, ctx)),
      )
      // execute resolves only once the first chunk is in hand, so this is
      // time-to-first-token without any plumbing into the stream itself.
      const ttftMs = Date.now() - startedAt
      dropped = droppedFor(result.candidate, body)

      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId, dropped),
        (outcome, capture) =>
          log(200, outcome, result.attempts, {
            ttftMs,
            candidate: result.candidate,
            usage: capture.usage,
          }),
      )
    }

    const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
      adapter.chat(body, ctx),
    )
    dropped = droppedFor(result.candidate, body)

    // Built before logging: logging after the response has been constructed
    // means a throw building the response can no longer race a second,
    // contradictory log line against this one for the same request_id.
    const response = Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId, dropped),
    })
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage: usageFrom(result.value.usage),
    })
    return response
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500
    // A client that disconnected mid-request surfaces here as an aborted
    // signal, which classifyProviderError reports as an upstream timeout —
    // that's the right status for a stuck response, but the wrong outcome:
    // the client left, no upstream is to blame.
    const outcome: RequestOutcome = request.signal.aborted ? 'client_closed' : 'error'
    log(status, outcome, err instanceof RoutedError ? err.attempts : [], { error: err })

    // Under failover the interesting provider is the last one tried, which
    // only the routed error knows.
    const headers: HeadersInit =
      err instanceof RoutedError && err.lastProvider
        ? { 'x-request-id': requestId, 'x-babellm-provider': err.lastProvider }
        : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
