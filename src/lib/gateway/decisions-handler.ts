import 'server-only'
import { decisionsIngress } from './protocols/decisions'
import { runGatewayRequest, type GatewayDeps } from './handler'

export function handleDecisions(request: Request, deps?: GatewayDeps): Promise<Response> {
  return runGatewayRequest(request, decisionsIngress, deps)
}
