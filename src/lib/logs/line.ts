import type { RequestLogEntry } from './types'

function level(entry: RequestLogEntry): 'info' | 'warn' | 'error' {
  // A stream that dies after its first chunk has already committed a 200, so
  // the status alone would report a failed request as a success.
  if (entry.outcome === 'stream_interrupted' || entry.status >= 500) return 'error'
  if (entry.status >= 400) return 'warn'
  return 'info'
}

/** Emits a key only when the number was actually measured. A missing count
 * and a count of zero mean different things and must not serialize alike. */
function measured(key: string, value: number | null | undefined) {
  return value === null || value === undefined ? {} : { [key]: value }
}

/**
 * The one place a request log line is shaped. Snake_case throughout, because
 * the consumer is a log aggregator rather than TypeScript.
 *
 * `targetId` is deliberately dropped: it is a uuid nobody can resolve without
 * the database, and the provider/model pair identifies the attempt for anyone
 * reading stdout.
 */
export function buildRequestLog(entry: RequestLogEntry): Record<string, unknown> {
  return {
    lvl: level(entry),
    msg: 'gateway.request',
    request_id: entry.requestId,
    key: entry.keyName,
    model: entry.model,
    stream: entry.stream,
    status: entry.status,
    outcome: entry.outcome,
    latency_ms: entry.latencyMs,
    ...(entry.ttftMs === undefined ? {} : { ttft_ms: entry.ttftMs }),
    ...(entry.droppedParams?.length ? { dropped_params: entry.droppedParams } : {}),
    ...measured('prompt_tokens', entry.usage?.promptTokens),
    ...measured('completion_tokens', entry.usage?.completionTokens),
    ...measured('cached_tokens', entry.usage?.cachedTokens),
    ...measured('reasoning_tokens', entry.usage?.reasoningTokens),
    ...(entry.cost?.totalUsd ? { cost_usd: entry.cost.totalUsd } : {}),
    attempts: entry.attempts.map((attempt) => ({
      n: attempt.n,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latency_ms: attempt.latencyMs,
      ...(attempt.error ? { error: attempt.error } : {}),
    })),
  }
}
