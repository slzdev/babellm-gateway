import 'server-only'
import { getHealthStore, resolveBreakerConfig } from '@/lib/health'
import { resolveRoutingSettings } from '@/lib/routing-settings'
import type { Candidate } from './resolve'

/**
 * Which of these candidates currently have an open breaker.
 *
 * Never throws. A health store that is unreachable yields an empty set, which
 * `selectOrder` reads as "nothing is open" — so routing degrades to exactly
 * its pre-breaker behaviour rather than to something worse.
 */
export async function openTargetsFor(
  candidates: Candidate[],
): Promise<ReadonlySet<string>> {
  const ids = candidates.filter((candidate) => candidate.breakable).map((c) => c.targetId)
  if (ids.length === 0) return new Set()

  try {
    return await getHealthStore().openTargets(ids)
  } catch (err) {
    console.error('[gateway] could not read target health; routing without it', err)
    return new Set()
  }
}

/**
 * Reports an attempt's outcome, fire-and-forget.
 *
 * Synchronous by signature and asynchronous underneath, deliberately: this is
 * called from the attempt loop, and awaiting it would put a Redis round trip
 * — and a Redis outage — on the path of a response that has already been
 * decided.
 */
export function recordHealth(
  candidate: Candidate,
  outcome: 'success' | 'failure',
  error?: string,
): void {
  void (async () => {
    const store = getHealthStore()
    if (outcome === 'success') {
      await store.succeed(candidate.targetId)
      return
    }
    // Only the failure path needs configuration, which is why no settings read
    // sits on the request-critical path at all.
    const globals = await resolveRoutingSettings()
    await store.fail(candidate.targetId, resolveBreakerConfig(candidate, globals), error ?? '')
  })().catch((err) => {
    console.error(`[gateway] failed to record target health target_id=${candidate.targetId}`, err)
  })
}
