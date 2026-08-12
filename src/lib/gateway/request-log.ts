import type { AttemptRecord } from './execute'

export type RequestOutcome = 'ok' | 'error' | 'client_closed' | 'stream_interrupted'

export interface RequestLogFields {
  requestId: string
  /**
   * The API key's *name*. Never the key, its prefix, or its hash. This
   * module cannot enforce that — it only ever sees whatever string the
   * caller passes as `key`. The caller is responsible for passing the name.
   */
  key: string | null
  /** The virtual model the client asked for. Null if the request never parsed. */
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  latencyMs: number
  /** Streaming only: time to the first chunk. */
  ttftMs?: number
  attempts: AttemptRecord[]
}

function level(fields: RequestLogFields): 'info' | 'warn' | 'error' {
  // A stream that dies after its first chunk has already committed a 200, so
  // the status alone would report a failed request as a success.
  if (fields.outcome === 'stream_interrupted' || fields.status >= 500) return 'error'
  if (fields.status >= 400) return 'warn'
  return 'info'
}

/**
 * The one place a request log line is shaped. Snake_case throughout, because
 * the consumer is a log aggregator rather than TypeScript.
 *
 * `targetId` is deliberately dropped: it is a uuid nobody can resolve without
 * the database, and the provider/model pair identifies the attempt for anyone
 * reading stdout.
 */
export function buildRequestLog(fields: RequestLogFields): Record<string, unknown> {
  return {
    lvl: level(fields),
    msg: 'gateway.request',
    request_id: fields.requestId,
    key: fields.key,
    model: fields.model,
    stream: fields.stream,
    status: fields.status,
    outcome: fields.outcome,
    latency_ms: fields.latencyMs,
    ...(fields.ttftMs === undefined ? {} : { ttft_ms: fields.ttftMs }),
    attempts: fields.attempts.map((attempt) => ({
      n: attempt.n,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latency_ms: attempt.latencyMs,
      ...(attempt.error ? { error: attempt.error } : {}),
    })),
  }
}

/**
 * Writes one line to stdout. Never throws: a request that succeeded must not
 * be turned into a failure by its own logging.
 */
export function emitRequestLog(fields: RequestLogFields): void {
  try {
    console.log(JSON.stringify(buildRequestLog(fields)))
  } catch (err) {
    // The fallback needs its own guard: stdout and stderr are frequently the
    // same pipe, so whatever just broke console.log has usually broken this
    // too. A request that succeeded must not be failed by its own logging,
    // and that promise is worth more than the diagnostic.
    try {
      console.error(`[gateway] failed to emit request log request_id=${fields.requestId}`, err)
    } catch {
      // Nowhere left to report to.
    }
  }
}
