import type { ChatCompletionChunk } from '@/lib/adapters/types'
import { classifyProviderError } from './errors'
import { rewriteChunk, type IdentityOptions } from './identity'

const encoder = new TextEncoder()

function event(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

const DONE = encoder.encode('data: [DONE]\n\n')

export interface StartedStream {
  chunks: AsyncIterable<ChatCompletionChunk>
}

/**
 * Pulls the first chunk eagerly. A failure here throws before the caller has
 * committed an HTTP response, which is what makes clean error status codes —
 * and, in Phase 2, failover — possible.
 */
export async function startChatStream(
  source: AsyncIterable<ChatCompletionChunk>,
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()

  return {
    async *[Symbol.asyncIterator]() {
      if (first.done) return
      yield first.value
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    },
  }
}

export function sseResponse(
  chunks: AsyncIterable<ChatCompletionChunk>,
  identity: IdentityOptions,
  headers: HeadersInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
      } catch (err) {
        const classified = classifyProviderError(err)
        controller.enqueue(
          event({
            error: {
              message: classified.message,
              type: classified.type,
              param: null,
              code: 'stream_interrupted',
            },
          }),
        )
      } finally {
        controller.enqueue(DONE)
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
