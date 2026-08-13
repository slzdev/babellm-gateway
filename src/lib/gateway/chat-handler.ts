import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter, resolveApiFlavor } from '@/lib/adapters/registry'
import type { ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { chatCompletionRequestSchema, type ChatCompletionRequest } from '@/lib/schemas/chat'
import { droppedParams } from '@/lib/translate/chat-to-responses'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { GatewayError, RoutedError, errorResponse } from './errors'
import { execute, type AttemptRecord } from './execute'
import { newCompletionId, rewriteCompletion } from './identity'
import { emitRequestLog, type RequestOutcome } from './request-log'
import { resolveModel, type Candidate } from './resolve'
import { selectOrder } from './select'
import { sseResponse, startChatStream } from './sse'

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

export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')
  const startedAt = Date.now()

  // Tracked outside the try so the log line can still say who was calling
  // and for what when the request never got as far as an attempt.
  let keyName: string | null = null
  let modelName: string | null = null
  let stream = false
  let dropped: string[] = []

  function log(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    ttftMs?: number,
  ) {
    emitRequestLog({
      requestId,
      key: keyName,
      model: modelName,
      stream,
      status,
      outcome,
      latencyMs: Date.now() - startedAt,
      ...(ttftMs === undefined ? {} : { ttftMs }),
      attempts,
      ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
    })
  }

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
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
        (outcome) => log(200, outcome, result.attempts, ttftMs),
      )
    }

    const result = await execute(chain, requestId, request.signal, deps, (adapter, ctx) =>
      adapter.chat(body, ctx),
    )
    dropped = droppedFor(result.candidate, body)

    log(200, 'ok', result.attempts)
    return Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId, dropped),
    })
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 500
    log(status, 'error', err instanceof RoutedError ? err.attempts : [])

    // Under failover the interesting provider is the last one tried, which
    // only the routed error knows.
    const headers: HeadersInit =
      err instanceof RoutedError && err.lastProvider
        ? { 'x-request-id': requestId, 'x-babellm-provider': err.lastProvider }
        : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
