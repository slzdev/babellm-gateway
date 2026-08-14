import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { LogUsage } from '@/lib/logs/types'
import { classifyProviderError, type ClassifiedError } from './errors'
import { rewriteChunk, type IdentityOptions } from './identity'
import { usageFrom } from './usage'

const encoder = new TextEncoder()

function event(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

const DONE = encoder.encode('data: [DONE]\n\n')

/** Assembles assistant text for payload capture, stopping at the byte cap.
 * Only runs when capture was requested, so streams for keys without payload
 * logging pay nothing.
 *
 * The post-truncation guard (stop calling this once `captured.truncated` is
 * set) lives at the CALL SITE, not here — see `if (capture &&
 * !captured.truncated)` below. Do not move that check into this function: a
 * future edit that relocates the call without carrying the guard would let a
 * later small chunk resume appending after truncation. */
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

export type StreamOutcome = 'ok' | 'client_closed' | 'stream_interrupted'

export interface StreamCapture {
  usage: LogUsage | null
  /** Assembled assistant text. Empty unless payload capture was requested. */
  text: string
  /** Byte length of `text`, tracked incrementally rather than recomputed. */
  bytes: number
  /** True once the text hit the byte cap and stopped accumulating. */
  truncated: boolean
  /** The classified error that killed the stream, so the settle callback —
   * and the row it logs — can say why. Null on every outcome but
   * stream_interrupted. */
  error: ClassifiedError | null
}

export interface CaptureOptions {
  /** Accumulate assistant text up to this many bytes, for payload capture. */
  maxBytes: number
}

export function sseResponse(
  started: StartedChatStream,
  identity: IdentityOptions,
  headers: HeadersInit,
  onSettle?: (outcome: StreamOutcome, capture: StreamCapture) => void,
  capture?: CaptureOptions,
): Response {
  // Set the moment the client disconnects. The `for await` below may still
  // be mid-pull when that happens (it does not know the controller is gone
  // until it tries to enqueue), so every enqueue site checks this before
  // touching the controller — a ReadableStreamController that has been
  // cancelled throws on `enqueue`, and an uncaught throw here would surface
  // as an unhandled rejection.
  let cancelled = false

  // An interrupted stream settles twice without this: the catch reports
  // stream_interrupted, and the finally then runs with cancelled still
  // false and reports ok on top of it. First one wins, so the outcome that
  // describes what actually happened is the one that survives.
  let settled = false

  // Accumulated as the stream is relayed, so the settle callback — whichever
  // of the three paths reaches it — reports what actually got through.
  const captured: StreamCapture = { usage: null, text: '', bytes: 0, truncated: false, error: null }

  function settle(outcome: StreamOutcome) {
    if (settled) return
    settled = true
    try {
      onSettle?.(outcome, captured)
    } catch (err) {
      console.error('[gateway] stream settle callback failed', err)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of started.chunks) {
          if (cancelled) return
          // include_usage puts this on the final chunk; a provider that omits
          // it simply leaves captured.usage null.
          if (chunk.usage) captured.usage = usageFrom(chunk.usage)
          if (capture && !captured.truncated) accumulate(captured, chunk, capture.maxBytes)
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
      } catch (err) {
        if (cancelled) return
        const classified = classifyProviderError(err)
        // Set before settle(), which hands `captured` straight to onSettle
        // synchronously — the log entry needs this in place by then.
        captured.error = classified
        settle('stream_interrupted')
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
          settle('ok')
          controller.enqueue(DONE)
          controller.close()
        }
      }
    },
    cancel() {
      cancelled = true
      settle('client_closed')
      // Ask the source iterator to run its cleanup (e.g. release the
      // upstream fetch) instead of leaving it to keep being pulled by
      // nobody. Without this, a client disconnect only stops progress
      // incidentally — via whatever AbortSignal the adapter happens to
      // wire up — rather than as a guaranteed consequence of cancellation.
      void started.iterator.return?.().catch(() => {
        // The client is already gone; a failed cleanup has no one to report
        // to and must not become an unhandled rejection that ends the process.
      })
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
