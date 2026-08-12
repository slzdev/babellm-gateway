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

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    const body = await parseBody(request)
    const { candidates } = await resolveVirtualModel(body.model)

    // Phase 1 uses the highest-priority target only. Phase 2 walks the list.
    const candidate = candidates[0]
    const adapter = deps.createAdapter(candidate.provider)
    const ctx = attemptContext(candidate, requestId, request.signal)
    const headers = attemptHeaders(candidate, requestId)

    void touchApiKey(apiKey.id).catch((err) =>
      console.error('[gateway] failed to update last_used_at', err),
    )

    if (body.stream) {
      throw new GatewayError({
        status: 501,
        type: 'api_error',
        code: 'streaming_not_implemented',
        message: 'Streaming is not implemented yet.',
      })
    }

    let completion
    try {
      completion = await adapter.chat(body, ctx)
    } catch (err) {
      throw upstreamFailure(err)
    }

    return Response.json(
      rewriteCompletion(completion, { id: newCompletionId(), model: body.model }),
      { headers },
    )
  } catch (err) {
    return errorResponse(err, { 'x-request-id': requestId })
  }
}
