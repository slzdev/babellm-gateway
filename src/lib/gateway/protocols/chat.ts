import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'
import { chatCompletionRequestSchema, type ChatCompletionRequest } from '@/lib/schemas/chat'
import type { ClassifiedError } from '../errors'
import { withUsageCost } from '../cost'
import { parseWith, type Ingress } from '../handler'
import { newCompletionId, rewriteChunk, rewriteCompletion } from '../identity'
import { droppedForChat } from './dropped'
import type { StreamCapture, StreamProtocol } from '../sse'
import { usageFrom } from '../usage'

const encoder = new TextEncoder()

/** Assembles assistant text for payload capture, stopping at the byte cap.
 * Only runs when capture was requested, so streams for keys without payload
 * logging pay nothing.
 *
 * The post-truncation guard (stop calling this once `captured.truncated` is
 * set) lives at the CALL SITE, not here — see the relay in sse.ts. Do not move
 * that check into this function: a future edit that relocates the call without
 * carrying the guard would let a later small chunk resume appending after
 * truncation. */
function accumulate(captured: StreamCapture, chunk: ChatCompletionChunk, maxBytes: number) {
  const delta = chunk.choices?.[0]?.delta?.content
  // Upstream JSON is untrusted: a non-string content field would make
  // Buffer.byteLength throw, and a throw here is inside the relay loop —
  // it would turn a healthy stream into an interrupted one.
  if (typeof delta !== 'string' || delta.length === 0) return
  const width = Buffer.byteLength(delta, 'utf8')
  // A running total rather than re-measuring the accumulated text on every
  // chunk, which would be quadratic over a token-per-chunk stream.
  if (captured.bytes + width > maxBytes) {
    captured.truncated = true
    return
  }
  captured.text += delta
  captured.bytes += width
}

export const chatStreamProtocol: StreamProtocol<ChatCompletionChunk> = {
  frame: (chunk, identity) =>
    encoder.encode(`data: ${JSON.stringify(rewriteChunk(chunk, identity))}\n\n`),
  terminator: encoder.encode('data: [DONE]\n\n'),
  errorEvent: (err: ClassifiedError) =>
    encoder.encode(`data: ${JSON.stringify({
      error: { message: err.message, type: err.type, param: null, code: 'stream_interrupted' },
    })}\n\n`),
  accumulate,
  usageOf: (chunk) => (chunk.usage ? usageFrom(chunk.usage) : null),
  // A chunk carrying reasoning but no content is still the first token from the
  // client's point of view: something generated arrived.
  isContentDelta: (chunk) => {
    const delta = chunk.choices?.[0]?.delta as { content?: unknown; reasoning_content?: unknown } | undefined
    return (typeof delta?.content === 'string' && delta.content.length > 0)
      || (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0)
  },
}

export const chatIngress: Ingress<ChatCompletionRequest, ChatCompletion, ChatCompletionChunk> = {
  parse: (raw) => parseWith(chatCompletionRequestSchema, raw),
  modelOf: (req) => req.model,
  isStream: (req) => req.stream === true,
  droppedFor: (candidate, req) => droppedForChat(candidate, req),
  run: (adapter, ctx, req) => adapter.chat(req, ctx),
  runStream: (adapter, ctx, req) => adapter.chatStream(req, ctx),
  finish: (res, identity, cost) => withUsageCost(rewriteCompletion(res, identity), cost),
  usageOf: (res) => usageFrom(res.usage),
  newIdentityId: newCompletionId,
  stream: chatStreamProtocol,
  captureResponse: (identity, capture, outcome) => ({
    id: identity.id,
    object: 'chat.completion',
    model: identity.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: capture.text },
      finish_reason: outcome === 'ok' ? 'stop' : null,
    }],
  }),
}
