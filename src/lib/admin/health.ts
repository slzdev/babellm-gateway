import 'server-only'
import { CLOSED, breakerState, getHealthStore, resolveBreakerConfig, type BreakerState } from '@/lib/health'
import { resolveRoutingSettings } from '@/lib/routing-settings'

export interface TargetBreakerView {
  state: BreakerState
  /** Seconds until the breaker reopens. null unless open. */
  reopensIn: number | null
  lastError: string | null
}

const CLOSED_VIEW: TargetBreakerView = { state: 'closed', reopensIn: null, lastError: null }

/**
 * The badge data for a page's worth of targets, in one store round trip.
 *
 * Reading health must never take the admin page down — an unreachable Redis
 * makes the column read "closed" rather than throwing a 500 at an operator who
 * is probably here *because* something is wrong.
 */
export async function targetBreakerViews(
  targets: Array<{
    id: string
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
  }>,
): Promise<Map<string, TargetBreakerView>> {
  const views = new Map<string, TargetBreakerView>()
  if (targets.length === 0) return views

  let globals
  let details
  try {
    ;[globals, details] = await Promise.all([
      resolveRoutingSettings(),
      getHealthStore().details(targets.map((target) => target.id)),
    ])
  } catch (err) {
    console.error('[gateway] could not read target health for the dashboard', err)
    for (const target of targets) views.set(target.id, CLOSED_VIEW)
    return views
  }

  for (const target of targets) {
    const health = details.get(target.id) ?? CLOSED
    const config = resolveBreakerConfig(target, globals)
    views.set(target.id, {
      state: breakerState(health, config),
      reopensIn: health.reopensIn,
      lastError: health.lastError,
    })
  }
  return views
}
