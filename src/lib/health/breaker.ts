import type { BreakerConfig, BreakerState, TargetHealth } from './types'

/**
 * The three-state reading, derived rather than stored.
 *
 * `half_open` is "the marker expired but the counter did not" — the probation
 * window in which the target is back in the chain and a single failure will
 * re-open it. Only this function knows that, because only a caller holding the
 * target's effective config can compare against a threshold.
 *
 * An observed open marker outranks configuration: if a target is live-open,
 * dropping its threshold to 0 must not hide that (dashboard reads healthy,
 * *Reset breaker* disables itself, and the store still demotes the target for
 * the rest of the cooldown regardless of what the config now says).
 */
export function breakerState(health: TargetHealth, config: BreakerConfig): BreakerState {
  if (health.open) return 'open'
  if (config.threshold <= 0) return 'closed'
  return health.consecutiveFailures >= config.threshold ? 'half_open' : 'closed'
}

/**
 * Per field, not per row: a target may pin a hair-trigger threshold and still
 * inherit the global cooldown.
 *
 * 0 is a real value here — it means "never open this target" — so the check is
 * for null, not for falsiness.
 */
export function resolveBreakerConfig(
  overrides: { breakerThreshold: number | null; breakerCooldownSeconds: number | null },
  globals: BreakerConfig,
): BreakerConfig {
  return {
    threshold: overrides.breakerThreshold ?? globals.threshold,
    cooldownSeconds: overrides.breakerCooldownSeconds ?? globals.cooldownSeconds,
  }
}
