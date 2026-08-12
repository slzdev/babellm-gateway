import type { ChatCompletionChunk } from '@/lib/adapters/types'
import { classifyProviderError } from './errors'
import { rewriteChunk, type IdentityOptions } from './identity'

const encoder = new TextEncoder()

function event(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

const DONE = encoder.encode('data: [DONE]\n\n')

export interface StartedChatStream {
  chunks: AsyncIterable<ChatCompletionChunk>
  /** The raw source iterator, exposed so a cancelled response can clean it up. */
  iterator: AsyncIterator<ChatCompletionChunk>
}

/**
 * Pulls the first chunk eagerly. A failure here throws before the caller has
 * committed an HTTP response, which is what makes clean error status codes —
 * and, in Phase 2, failover — possible.
 */
export async function startChatStream(
  source: AsyncIterable<ChatCompletionChunk>,
): Promise<StartedChatStream> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()

  return {
    iterator,
    chunks: {
      async *[Symbol.asyncIterator]() {
        if (first.done) return
        yield first.value
        while (true) {
          const next = await iterator.next()
          if (next.done) return
          yield next.value
        }
      },
    },
  }
}

export function sseResponse(
  started: StartedChatStream,
  identity: IdentityOptions,
  headers: HeadersInit,
): Response {
  // Set the moment the client disconnects. The `for await` below may still
  // be mid-pull when that happens (it does not know the controller is gone
  // until it tries to enqueue), so every enqueue site checks this before
  // touching the controller — a ReadableStreamController that has been
  // cancelled throws on `enqueue`, and an uncaught throw here would surface
  // as an unhandled rejection.
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of started.chunks) {
          if (cancelled) return
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
      } catch (err) {
        if (cancelled) return
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
        if (!cancelled) {
          controller.enqueue(DONE)
          controller.close()
        }
      }
    },
    cancel() {
      cancelled = true
      // Ask the source iterator to run its cleanup (e.g. release the
      // upstream fetch) instead of leaving it to keep being pulled by
      // nobody. Without this, a client disconnect only stops progress
      // incidentally — via whatever AbortSignal the adapter happens to
      // wire up — rather than as a guaranteed consequence of cancellation.
      void started.iterator.return?.()
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
