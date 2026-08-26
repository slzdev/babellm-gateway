import 'server-only'
import { transcriptionIngress } from './protocols/transcription'
import { runGatewayRequest, type GatewayDeps } from './handler'

export function handleTranscriptions(request: Request, deps?: GatewayDeps): Promise<Response> {
  return runGatewayRequest(request, transcriptionIngress, deps)
}
