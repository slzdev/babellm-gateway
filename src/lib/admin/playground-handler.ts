import 'server-only'
import { z } from 'zod'
import { createAdapter } from '@/lib/adapters/registry'
import { resolveApiKeyById } from '@/lib/gateway/auth'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { GatewayError, errorResponse } from '@/lib/gateway/errors'
import { parseWith, readJson, type GatewayDeps } from '@/lib/gateway/handler'
import { isAuthenticated } from './session'

export interface PlaygroundHandlerDeps {
  isAuthenticated: () => Promise<boolean>
  createAdapter: GatewayDeps['createAdapter']
}

const defaultDeps: PlaygroundHandlerDeps = { isAuthenticated, createAdapter }
const selectionSchema = z.object({ apiKeyId: z.uuid() }).passthrough()

function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin') return false

  const rawOrigin = request.headers.get('origin')
  // An Origin is only scheme + authority. URL alone also accepts paths,
  // credentials and backslashes, none of which are valid Origin headers.
  if (!rawOrigin || !/^https?:\/\/[^\s/?#\\]+$/i.test(rawOrigin)) return false
  try {
    const origin = new URL(rawOrigin)
    if (origin.username || origin.password) return false
    const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
      ?? request.headers.get('host')
      ?? new URL(request.url).host
    return origin.host === host.toLowerCase()
  } catch {
    return false
  }
}

export async function handlePlaygroundChat(
  request: Request,
  deps: PlaygroundHandlerDeps = defaultDeps,
): Promise<Response> {
  try {
    if (!(await deps.isAuthenticated())) {
      throw new GatewayError({
        status: 401, type: 'invalid_request_error', code: 'unauthorized',
        message: 'An admin session is required.',
      })
    }
    if (!isSameOrigin(request)) {
      throw new GatewayError({
        status: 403, type: 'invalid_request_error', code: 'forbidden',
        message: 'A same-origin request is required.',
      })
    }

    const { apiKeyId, ...body } = parseWith(selectionSchema, await readJson(request))
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-babellm-tags': 'source=playground' },
      body: JSON.stringify(body),
      signal: request.signal,
    })
    return await handleChatCompletions(forwarded, {
      createAdapter: deps.createAdapter,
      resolveKey: () => resolveApiKeyById(apiKeyId),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
