import 'server-only'
import * as settings from '@/lib/settings'
import {
  DEFAULT_PAYLOAD_MAX_BYTES, DEFAULT_RETENTION_MONTHS, type LoggingSettings,
} from '@/lib/settings'
import { postgresStore } from './postgres'
import type { RequestLogStore } from './types'

/** Every driver the gateway ships. Adding one is a fork's single entry here
 * plus a module implementing RequestLogStore. */
export const DRIVERS: Record<string, RequestLogStore> = {
  postgres: postgresStore,
}

/**
 * Where logging goes when the configured driver cannot be used.
 *
 * The default driver, not a store of its own. A settings read that failed is
 * usually the database being unreachable, so this store's writes will
 * generally fail too — each one reported on stderr by the caller's .catch()
 * rather than becoming a serving failure. That is the honest outcome: a
 * gateway that cannot reach its database cannot durably log either, and
 * pretending otherwise would only move the loss somewhere quieter.
 */
const FALLBACK_STORE = postgresStore

/**
 * How long a resolved store and its settings are trusted.
 *
 * The whole bundle is cached, not just the driver name: caching only the name
 * would trade one query per request for two. The cost is that a store switch
 * takes up to this long to reach other instances, which the Governance tab
 * states plainly.
 */
export const LOG_SETTINGS_TTL_MS = 15_000

export interface StoreResolution {
  store: RequestLogStore
  /** The driver name that was configured, which may not be the one resolved. */
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  settings: LoggingSettings
}

let cached: { at: number; resolution: StoreResolution } | null = null
let inflight: Promise<StoreResolution> | null = null
let generation = 0

export function clearRequestLogStoreCache(): void {
  cached = null
  inflight = null
  // Any resolution still in flight was started against settings that have
  // since changed. Bumping the generation makes it return its value to its
  // own callers without publishing it to the cache.
  generation += 1
}

export async function resolveRequestLogStore(): Promise<StoreResolution> {
  if (cached && Date.now() - cached.at < LOG_SETTINGS_TTL_MS) return cached.resolution

  // Concurrent callers share one resolution. Without this, every request that
  // arrives during a miss window issues its own settings query — and when that
  // query is the thing that is failing, caching the failure would no longer
  // protect the database it is failing against.
  const startedAt = generation
  inflight ??= resolve()
    .then((resolution) => {
      // A clear that happened while this resolution was in flight (e.g. an
      // admin's settings write) must not have its cache repopulated by a
      // resolution computed against the pre-write state. The caller still
      // gets its answer below; only the cache write is suppressed.
      if (startedAt === generation) cached = { at: Date.now(), resolution }
      return resolution
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export async function getRequestLogStore(): Promise<RequestLogStore> {
  return (await resolveRequestLogStore()).store
}

async function resolve(): Promise<StoreResolution> {
  let loggingSettings: LoggingSettings
  try {
    loggingSettings = await settings.getLoggingSettings()
  } catch (err) {
    console.error(
      `[gateway] could not read logging settings; logging to ${FALLBACK_STORE.name}`, err,
    )
    // Refusing to serve requests because a *logging* setting could not be read
    // would be the wrong hierarchy of concerns.
    return {
      store: FALLBACK_STORE,
      configured: 'unknown',
      fallback: 'settings_error',
      settings: {
        store: FALLBACK_STORE.name,
        retentionMonths: DEFAULT_RETENTION_MONTHS,
        payloadMaxBytes: DEFAULT_PAYLOAD_MAX_BYTES,
      },
    }
  }

  // `Object.hasOwn`, not a bare lookup: DRIVERS is a plain object literal, so
  // a name like "constructor" or "toString" resolves via the prototype chain
  // to a builtin (e.g. the `Object` function) instead of `undefined` — which
  // is truthy, so a falsy check alone would hand back a non-driver as if it
  // were one. This is the layer that must not be fooled: `store` here can
  // come from anywhere logs.store can be set, not only this task's form.
  const store = Object.hasOwn(DRIVERS, loggingSettings.store)
    ? DRIVERS[loggingSettings.store]
    : undefined
  if (!store) {
    console.error(
      `[gateway] no request log driver named "${loggingSettings.store}"; logging to ${FALLBACK_STORE.name}`,
    )
    return {
      store: FALLBACK_STORE, configured: loggingSettings.store, fallback: 'unknown_driver', settings: loggingSettings,
    }
  }

  return { store, configured: loggingSettings.store, fallback: null, settings: loggingSettings }
}
