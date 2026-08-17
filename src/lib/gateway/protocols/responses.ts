import type { AttemptContext, ResponseStreamEvent, ResponsesResult } from '@/lib/adapters/types'
import type { LogUsage } from '@/lib/logs/types'
import { responsesRequestSchema, type ResponsesRequest } from '@/lib/schemas/responses'
import { UnsupportedOperationError, type ClassifiedError } from '../errors'
import { parseWith, type Ingress } from '../handler'
import { newResponseId, rewriteResponse } from '../identity'
import type { StreamCapture, StreamProtocol } from '../sse'
import { usageFromResponses } from '../usage'

const encoder = new TextEncoder()

const CONTENT_DELTAS = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
])

/** The events that carry a full response object, whose model needs rewriting
 *  to the virtual name the client asked for. */
const CARRIES_RESPONSE = new Set([
  'response.created', 'response.in_progress', 'response.completed',
  'response.incomplete', 'response.failed', 'response.queued',
])

export const responsesStreamProtocol: StreamProtocol<ResponseStreamEvent> = {
  frame: (event, identity) => {
    const payload = CARRIES_RESPONSE.has(event.type) && 'response' in event
      ? { ...event, response: rewriteResponse(event.response, identity) }
      : event
    // Both lines: the real API sends a named event, and clients that are not
    // the OpenAI SDK read `event:` rather than sniffing `data.type`.
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)
  },

  // The real API ends on response.completed and sends no sentinel; the SDK
  // treats [DONE] as optional (openai/core/streaming.js:35).
  terminator: null,

  errorEvent: (err: ClassifiedError) =>
    encoder.encode(`event: error\ndata: ${JSON.stringify({
      type: 'error', code: 'stream_interrupted', message: err.message, param: null,
    })}\n\n`),

  accumulate: (captured: StreamCapture, event, maxBytes) => {
    // Only the assistant's answer. Reasoning summaries are not what the client
    // received as content, so capturing them would misrepresent the response.
    if (event.type !== 'response.output_text.delta') return
    const delta = (event as { delta?: unknown }).delta
    // Upstream JSON is untrusted: a non-string delta would make
    // Buffer.byteLength throw, and a throw here is inside the relay loop —
    // it would turn a healthy stream into an interrupted one.
    if (typeof delta !== 'string' || delta.length === 0) return
    const width = Buffer.byteLength(delta, 'utf8')
    if (captured.bytes + width > maxBytes) {
      captured.truncated = true
      return
    }
    captured.text += delta
    captured.bytes += width
  },

  usageOf: (event): LogUsage | null => {
    if (!('response' in event) || !event.response) return null
    return usageFromResponses((event.response as { usage?: unknown }).usage as never)
  },

  isContentDelta: (event) => CONTENT_DELTAS.has(event.type),
}

/**
 * An adapter that does not implement the pair cannot serve this shape at all.
 * 501 rather than 500: classifyProviderError already maps
 * UnsupportedOperationError to a non-retryable 501, which is the same answer an
 * unimplemented adapter type gives.
 */
function requirePair<T>(method: T | undefined, ctx: AttemptContext, name: string): T {
  if (!method) {
    throw new UnsupportedOperationError(
      `This provider cannot serve a Responses request for \`${ctx.upstreamModel}\`: it has no ${name} implementation. Set the route target's API flavor to "responses".`,
    )
  }
  return method
}

export const responsesIngress: Ingress<ResponsesRequest, ResponsesResult, ResponseStreamEvent> = {
  parse: (raw) => parseWith(responsesRequestSchema, raw),
  modelOf: (req) => req.model,
  isStream: (req) => req.stream === true,
  // Filled in by Task 14; a passthrough target expresses everything it is sent.
  droppedFor: () => [],
  run: (adapter, ctx, req) =>
    requirePair(adapter.respond, ctx, 'respond').call(adapter, req, ctx),
  runStream: (adapter, ctx, req) =>
    requirePair(adapter.respondStream, ctx, 'respondStream').call(adapter, req, ctx),
  finish: (res, identity) => rewriteResponse(res, identity),
  usageOf: (res) => usageFromResponses(res.usage as never),
  newIdentityId: newResponseId,
  stream: responsesStreamProtocol,
  captureResponse: (identity, capture, outcome) => ({
    id: identity.id,
    object: 'response',
    model: identity.model,
    status: outcome === 'ok' ? 'completed' : 'incomplete',
    output: [{
      type: 'message', role: 'assistant', status: outcome === 'ok' ? 'completed' : 'incomplete',
      content: [{ type: 'output_text', text: capture.text, annotations: [] }],
    }],
  }),
}
