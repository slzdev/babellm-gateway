import 'server-only'
import { chatIngress } from './protocols/chat'
import { runGatewayRequest, type GatewayDeps } from './handler'

export type ChatHandlerDeps = GatewayDeps

export function handleChatCompletions(
  request: Request,
  deps?: ChatHandlerDeps,
): Promise<Response> {
  return runGatewayRequest(request, chatIngress, deps)
}
