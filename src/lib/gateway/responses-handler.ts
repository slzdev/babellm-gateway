import 'server-only'
import { responsesIngress } from './protocols/responses'
import { runGatewayRequest, type GatewayDeps } from './handler'

export function handleResponses(request: Request, deps?: GatewayDeps): Promise<Response> {
  return runGatewayRequest(request, responsesIngress, deps)
}
