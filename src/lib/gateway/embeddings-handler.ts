import 'server-only'
import { embeddingsIngress } from './protocols/embeddings'
import { runGatewayRequest, type GatewayDeps } from './handler'

export function handleEmbeddings(request: Request, deps?: GatewayDeps): Promise<Response> {
  return runGatewayRequest(request, embeddingsIngress, deps)
}
