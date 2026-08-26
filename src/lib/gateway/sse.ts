import type { CostBreakdown, LogUsage } from '@/lib/logs/types'
import { costPayload, type CostPayload } from './cost'
import { classifyProviderError, type ClassifiedError } from './errors'
import type { IdentityOptions } from './identity'

/**
 * The framing and accounting that differ between ingresses (Chat's unnamed
 * `data:` events terminated by `[DONE]`, Responses' named `event:` lines with
 * no terminator) live behind this interface. Everything else in this file —
 * the relay loop, disconnect handling, single-settle discipline — is shared.
 */
export interface StreamProtocol<Chunk> {
  frame(chunk: Chunk, identity: IdentityOptions): Uint8Array
  terminator: Uint8Array | null
  errorEvent(err: ClassifiedError): Uint8Array
  accumulate(captured: StreamCapture, chunk: Chunk, maxBytes: number): void
  usageOf(chunk: Chunk): LogUsage | null
  /** Writes the cost into a chunk that carries usage. Called only for chunks
   *  whose usageOf() returned non-null, so an implementation never has to
   *  invent a usage object. */
  attachCost(chunk: Chunk, cost: CostPayload | null): Chunk
  /** True for an event that carries generated content, which is what TTFT measures. */
  isContentDelta(chunk: Chunk): boolean
}

export interface StartedStream<Chunk> {
  chunks: AsyncIterable<Chunk>
  /** The raw source iterator, exposed so a cancelled response can clean it up. */
  iterator: AsyncIterator<Chunk>
}

/**
 * Pulls the first chunk eagerly. A failure here throws before the caller has
 * committed an HTTP response, which is what makes clean error status codes —
 * and, in Phase 2, failover — possible.
 */
export async function startStream<Chunk>(
  source: AsyncIterable<Chunk>,
): Promise<StartedStream<Chunk>> {
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
  /** The cost of `usage`, as the client was told it.
   *
   * The internal CostBreakdown, not the wire CostPayload: the request log
   * stores the catalog rates in their own column (logs/postgres.ts), so
   * narrowing this to the client's shape would silently strip `pricing` out
   * of every logged row. */
  cost: CostBreakdown | null
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
  /** Epoch ms of the first content-bearing event, for TTFT. Null if none arrived. */
  firstDeltaAt: number | null
}

export interface CaptureOptions {
  /** Accumulate assistant text up to this many bytes, for payload capture. */
  maxBytes: number
}

export function sseResponse<Chunk>(
  started: StartedStream<Chunk>,
  protocol: StreamProtocol<Chunk>,
  identity: IdentityOptions,
  headers: HeadersInit,
  onSettle?: (outcome: StreamOutcome, capture: StreamCapture) => void,
  capture?: CaptureOptions,
  costFor?: (usage: LogUsage) => Promise<CostBreakdown | null>,
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
  const captured: StreamCapture = {
    usage: null, cost: null, text: '', bytes: 0, truncated: false,
    error: null, firstDeltaAt: null,
  }

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
          const usage = protocol.usageOf(chunk)
          // The chunk actually framed. Reassigned only for a usage-bearing
          // chunk, so a content delta is relayed as the identical object.
          let outgoing: Chunk = chunk
          if (usage) {
            captured.usage = usage
            if (costFor) {
              // The only await in this loop that is not pulling from upstream.
              // It resolves a promise the handler started before the response
              // was returned, so by the time usage arrives — the last chunk —
              // it has long since settled and this costs a microtask. Placing
              // it here rather than before the response is what keeps a
              // catalog query off time-to-first-token.
              //
              // Guarded with .catch rather than left to the surrounding
              // try/catch: a costFor rejection is not a broken stream, and
              // letting it reach the catch below would have
              // classifyProviderError turn a perfectly healthy stream into a
              // stream_interrupted error sent to the client. A pricing
              // failure degrades to a null cost instead.
              captured.cost = await costFor(usage).catch(() => null)
              outgoing = protocol.attachCost(chunk, costPayload(captured.cost))
            }
          }
          // Recorded on the first content-bearing event rather than the first event
          // at all: a Responses stream opens with response.created, which upstream
          // emits instantly, and a chat stream opens with the role delta. Neither is
          // a token, and treating them as one reports a TTFT of nearly zero.
          if (captured.firstDeltaAt === null && protocol.isContentDelta(chunk)) {
            captured.firstDeltaAt = Date.now()
          }
          if (capture && !captured.truncated) protocol.accumulate(captured, chunk, capture.maxBytes)
          controller.enqueue(protocol.frame(outgoing, identity))
        }
      } catch (err) {
        if (cancelled) return
        const classified = classifyProviderError(err)
        // Set before settle(), which hands `captured` straight to onSettle
        // synchronously — the log entry needs this in place by then.
        captured.error = classified
        settle('stream_interrupted')
        controller.enqueue(protocol.errorEvent(classified))
      } finally {
        if (!cancelled) {
          settle('ok')
          if (protocol.terminator) controller.enqueue(protocol.terminator)
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
