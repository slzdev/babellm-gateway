import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter } from '@/lib/adapters/registry'
import type { AttemptContext, ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { chatCompletionRequestSchema } from '@/lib/schemas/chat'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { GatewayError, classifyProviderError, errorResponse } from './errors'
import { newCompletionId, rewriteCompletion } from './identity'
import { resolveVirtualModel, type Candidate } from './resolve'
import { sseResponse, startChatStream } from './sse'

const DEFAULT_TIMEOUT_MS = 120_000

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

export function attemptContext(
  candidate: Candidate,
  requestId: string,
  clientSignal: AbortSignal,
): AttemptContext {
  const config = JSON.parse(candidate.provider.config) as { timeoutMs?: number }
  return {
    upstreamModel: candidate.upstreamModel,
    requestId,
    signal: AbortSignal.any([
      clientSignal,
      AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ]),
  }
}

export function attemptHeaders(candidate: Candidate, requestId: string): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
  }
}

function upstreamFailure(err: unknown): GatewayError {
  const classified = classifyProviderError(err)
  return new GatewayError({
    status: classified.status,
    type: classified.type,
    code: classified.code,
    message: classified.message,
  })
}

export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')
  // Tracked outside the try block so the catch handler can report which
  // provider was in flight once a target has actually been chosen.
  let candidate: Candidate | undefined

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    const body = await parseBody(request)
    const { candidates } = await resolveVirtualModel(body.model)

    // Phase 1 uses the highest-priority target only. Phase 2 walks the list.
    candidate = candidates[0]
    const ctx = attemptContext(candidate, requestId, request.signal)
    const headers = attemptHeaders(candidate, requestId)

    // createAdapter throws for unimplemented adapter types (e.g. gemini,
    // bedrock) and for misconfigured providers. It must be wrapped the same
    // as the two calls below it, or those errors escape as opaque 500s
    // instead of the classified status classifyProviderError already knows
    // how to produce (501 for UnsupportedOperationError, in particular).
    let adapter: ProviderAdapter
    try {
      adapter = deps.createAdapter(candidate.provider)
    } catch (err) {
      throw upstreamFailure(err)
    }

    void touchApiKey(apiKey.id).catch((err) =>
      console.error(`[gateway] failed to update last_used_at request_id=${requestId}`, err),
    )

    const identity = { id: newCompletionId(), model: body.model }

    if (body.stream) {
      let started
      try {
        started = await startChatStream(adapter.chatStream(body, ctx))
      } catch (err) {
        throw upstreamFailure(err)
      }
      return sseResponse(started, identity, headers)
    }

    let completion
    try {
      completion = await adapter.chat(body, ctx)
    } catch (err) {
      throw upstreamFailure(err)
    }

    return Response.json(rewriteCompletion(completion, identity), { headers })
  } catch (err) {
    // Once a target has been chosen, say which provider failed — that is
    // the only place x-babellm-provider/upstream-model can come from.
    const headers = candidate
      ? attemptHeaders(candidate, requestId)
      : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
