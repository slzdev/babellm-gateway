import 'server-only'
import type { AttemptContext, ProviderAdapter, TargetSettings } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '@/lib/timeouts'
import {
  RoutedError,
  classifyProviderError,
  type ClassifiedError,
} from './errors'
import type { Candidate } from './resolve'

export interface AttemptRecord {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  /** The classified code and message. Absent when the attempt succeeded. */
  error?: string
}

export interface ExecuteResult<T> {
  value: T
  /** The target that actually served, which under failover is not the first. */
  candidate: Candidate
  attempts: AttemptRecord[]
}

export interface ExecuteDeps {
  createAdapter: (provider: ProviderRow, settings: TargetSettings) => ProviderAdapter
  /**
   * Reports an attempt's outcome to the circuit breaker.
   *
   * Synchronous and must never throw: the implementation is fire-and-forget,
   * like emitRequestLog. Health bookkeeping may not add latency to a response
   * or fail a request that has already succeeded.
   */
  recordHealth?: (
    candidate: Candidate,
    outcome: 'success' | 'failure',
    error?: string,
  ) => void
}

/**
 * The provider's stored ceiling, or the default when what is stored is not a
 * millisecond count AbortSignal.timeout can act on.
 *
 * The form validates through parseTimeoutMs and readTimeoutMs guards what it
 * renders, but `config` is a JSON blob an operator can edit straight in the
 * database — and this is the only reader on the request path. A stored `0` or
 * a negative would abort every request to that provider on the next tick, and
 * a string would abort them just as fast after WebIDL coerces it; either way
 * the error that surfaces is an abort with nothing in it that names a
 * timeout. Falling back is the only outcome an operator could diagnose.
 */
function resolveTimeoutMs(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return DEFAULT_TIMEOUT_MS
  if (stored < 1 || stored > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS
  return stored
}

export function attemptContext(
  candidate: Candidate,
  requestId: string,
  clientSignal: AbortSignal,
): AttemptContext {
  const config = JSON.parse(candidate.provider.config) as { timeoutMs?: unknown }
  return {
    upstreamModel: candidate.upstreamModel,
    requestId,
    signal: AbortSignal.any([
      clientSignal,
      // Nothing cancels this timer when the attempt finishes early —
      // AbortSignal.timeout hands back no clearable handle — so every attempt
      // leaves one pending entry for the full ceiling. Invisible at the old
      // hidden 120s, less so now that operators are invited to set values up
      // to an hour: a busy provider then holds roughly rps × 3600 of them.
      // Node's timers are cheap and unref'd, so this is a footprint question
      // and not a correctness one; if it ever shows up as unexplained memory
      // growth, the fix is an explicit AbortController plus a setTimeout the
      // finally-block clears.
      AbortSignal.timeout(resolveTimeoutMs(config.timeoutMs)),
    ]),
  }
}

function record(
  index: number,
  candidate: Candidate,
  latencyMs: number,
  classified?: ClassifiedError,
): AttemptRecord {
  return {
    n: index + 1,
    targetId: candidate.targetId,
    provider: candidate.provider.name,
    model: candidate.upstreamModel,
    status: classified?.status ?? 200,
    latencyMs,
    ...(classified
      ? {
          error: classified.code
            ? `${classified.code}: ${classified.message}`
            : classified.message,
        }
      : {}),
  }
}

function routed(
  classified: ClassifiedError,
  attempts: AttemptRecord[],
  candidate: Candidate | undefined,
): RoutedError {
  return new RoutedError({
    status: classified.status,
    type: classified.type,
    code: classified.code,
    message: classified.message,
    attempts,
    lastProvider: candidate?.provider.name ?? null,
  })
}

/**
 * Walks the attempt chain until something succeeds.
 *
 * Generic over `run` so streaming and non-streaming share one loop: the
 * streaming caller passes a `run` that pulls the first chunk, which is what
 * makes the failover boundary and the HTTP commit boundary the same line of
 * code rather than two that have to be kept in step.
 *
 * `run` is handed the candidate as well as the adapter because the request
 * body is per-target, not per-request: a target that pins a service tier needs
 * its own body, and the next target in the chain must not inherit it.
 */
export async function execute<T>(
  chain: Candidate[],
  requestId: string,
  clientSignal: AbortSignal,
  deps: ExecuteDeps,
  run: (
    adapter: ProviderAdapter,
    ctx: AttemptContext,
    candidate: Candidate,
  ) => Promise<T>,
): Promise<ExecuteResult<T>> {
  const attempts: AttemptRecord[] = []
  let last: RoutedError | undefined

  const recordHealth = (
    candidate: Candidate,
    outcome: 'success' | 'failure',
    error?: string,
  ) => {
    // A direct provider/model address has no route_targets row behind it and
    // is never demoted, so there is nothing to learn about it.
    if (candidate.breakable) deps.recordHealth?.(candidate, outcome, error)
  }

  for (const [index, candidate] of chain.entries()) {
    const startedAt = Date.now()

    let adapter: ProviderAdapter
    try {
      adapter = deps.createAdapter(candidate.provider, {
        flavor: candidate.apiFlavor,
        paths: candidate.pathOverrides,
        maxOutputTokens: candidate.maxOutputTokens,
        forceStream: candidate.forceUpstreamStream,
      })
    } catch (err) {
      // A provider the gateway cannot even construct an adapter for — an
      // unimplemented adapter type, or missing credentials — is one target's
      // problem, not the request's. Skip it and let a sibling serve. If the
      // whole chain is unconstructable, `last` still surfaces the real
      // reason (501 unsupported_operation, rather than an opaque 500).
      const classified = classifyProviderError(err)
      attempts.push(record(index, candidate, Date.now() - startedAt, classified))
      // A target the gateway cannot even construct is the weakest possible
      // explanation for a failed request, so it must never displace a real
      // upstream error recorded earlier in the chain. Keeping the first one
      // also keeps the surfaced error stable when the policy reorders the
      // chain between requests.
      if (!last) last = routed(classified, attempts, candidate)
      continue
    }

    try {
      const value = await run(
        adapter,
        attemptContext(candidate, requestId, clientSignal),
        candidate,
      )
      attempts.push(record(index, candidate, Date.now() - startedAt))
      recordHealth(candidate, 'success')
      return { value, candidate, attempts }
    } catch (err) {
      const classified = classifyProviderError(err)
      attempts.push(record(index, candidate, Date.now() - startedAt, classified))
      last = routed(classified, attempts, candidate)

      // Only a retryable failure is evidence about the target. A 4xx means it
      // answered, and an aborted client produces a retryable 504 that says
      // nothing about the provider at all.
      if (classified.retryable && !clientSignal.aborted) {
        recordHealth(candidate, 'failure', classified.message)
      }

      // Failing over onto a request nobody is waiting for wastes an upstream
      // call and, worse, can leave a second provider streaming into a closed
      // socket.
      if (!classified.retryable || clientSignal.aborted) throw last
    }
  }

  // Reached only when every attempt was retryable. The client gets the last
  // provider's actual complaint — three rate-limited providers should read as
  // 429, not as a blanket 502 that clients handle as a gateway bug.
  throw (
    last ??
    new RoutedError({
      status: 503,
      type: 'api_error',
      code: 'no_targets_available',
      message: 'No route targets were available to serve this request.',
      attempts,
    })
  )
}
