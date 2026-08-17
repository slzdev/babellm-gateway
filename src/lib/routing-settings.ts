import 'server-only'
import type { BreakerConfig } from '@/lib/health/types'
import {
  DEFAULT_BREAKER_COOLDOWN_SECONDS, DEFAULT_BREAKER_THRESHOLD, getRoutingSettings,
} from '@/lib/settings'

/**
 * How long resolved breaker settings are trusted.
 *
 * The failure path reads these on every failed attempt, and a provider outage
 * is exactly when failures are most frequent — so an uncached read would turn
 * an upstream outage into a burst of queries against the database that also
 * serves the dashboard. The cost is that a threshold change takes up to this
 * long to reach other instances, which the Settings page states plainly.
 */
export const ROUTING_SETTINGS_TTL_MS = 10_000

const FALLBACK: BreakerConfig = {
  threshold: DEFAULT_BREAKER_THRESHOLD,
  cooldownSeconds: DEFAULT_BREAKER_COOLDOWN_SECONDS,
}

let cached: { at: number; config: BreakerConfig } | null = null
let inflight: Promise<BreakerConfig> | null = null
let generation = 0

export function clearRoutingSettingsCache(): void {
  cached = null
  inflight = null
  // Any resolution still in flight was started against settings that have
  // since changed. Bumping the generation makes it return its value to its
  // own callers without publishing it to the cache.
  generation += 1
}

export async function resolveRoutingSettings(): Promise<BreakerConfig> {
  if (cached && Date.now() - cached.at < ROUTING_SETTINGS_TTL_MS) return cached.config

  // Concurrent callers share one resolution. Without this, every failed
  // attempt during a miss window issues its own query — and when the database
  // is the thing that is struggling, that is the worst possible moment.
  const startedAt = generation
  inflight ??= read()
    .then((config) => {
      if (startedAt === generation) cached = { at: Date.now(), config }
      return config
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function read(): Promise<BreakerConfig> {
  try {
    return await getRoutingSettings()
  } catch (err) {
    // Refusing to serve requests because a *breaker tuning* value could not be
    // read would be the wrong hierarchy of concerns.
    console.error('[gateway] could not read routing settings; using defaults', err)
    return FALLBACK
  }
}
