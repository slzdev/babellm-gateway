import 'server-only'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'

export const DEFAULT_REGISTRY_URL = 'https://models.dev/api.json'

export interface CatalogSettings {
  registryEnabled: boolean
  registryUrl: string
}

const KEYS = {
  registryEnabled: 'catalog.registry_enabled',
  registryUrl: 'catalog.registry_url',
} as const

export async function getCatalogSettings(): Promise<CatalogSettings> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const enabled = byKey.get(KEYS.registryEnabled)
  const url = byKey.get(KEYS.registryUrl)

  return {
    registryEnabled: typeof enabled === 'boolean' ? enabled : true,
    registryUrl: typeof url === 'string' && url.length > 0 ? url : DEFAULT_REGISTRY_URL,
  }
}

export async function setCatalogSettings(
  patch: Partial<CatalogSettings>,
): Promise<CatalogSettings> {
  const writes: Array<[string, unknown]> = []

  if (patch.registryEnabled !== undefined) {
    writes.push([KEYS.registryEnabled, patch.registryEnabled])
  }
  if (patch.registryUrl !== undefined) {
    const url = patch.registryUrl.trim()
    if (!url) throw new Error('A registry URL is required.')
    try {
      new URL(url)
    } catch {
      throw new Error(`"${url}" is not a valid URL.`)
    }
    writes.push([KEYS.registryUrl, url])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }

  return getCatalogSettings()
}

export const DEFAULT_LOG_STORE = 'postgres'
export const DEFAULT_RETENTION_MONTHS = 3
export const DEFAULT_PAYLOAD_MAX_BYTES = 262_144

export interface LoggingSettings {
  store: string
  /**
   * Calendar months kept: the current one plus the `retentionMonths - 1`
   * before it. `0` keeps everything.
   *
   * Months rather than days because a monthly partition can only be discarded
   * whole. A day-granular setting would either lie — 30 keeping up to 60 days
   * of prompt content — or need a row-level DELETE path kept alive purely to
   * honour the last few days.
   */
  retentionMonths: number
  payloadMaxBytes: number
}

const LOG_KEYS = {
  store: 'logs.store',
  retentionMonths: 'logs.retention_months',
  payloadMaxBytes: 'logs.payload_max_bytes',
} as const

export async function getLoggingSettings(): Promise<LoggingSettings> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const store = byKey.get(LOG_KEYS.store)
  const retention = byKey.get(LOG_KEYS.retentionMonths)
  const cap = byKey.get(LOG_KEYS.payloadMaxBytes)

  return {
    store: typeof store === 'string' && store.length > 0 ? store : DEFAULT_LOG_STORE,
    retentionMonths:
      typeof retention === 'number' && retention >= 0 ? retention : DEFAULT_RETENTION_MONTHS,
    payloadMaxBytes:
      typeof cap === 'number' && cap > 0 ? cap : DEFAULT_PAYLOAD_MAX_BYTES,
  }
}

export async function setLoggingSettings(
  patch: Partial<LoggingSettings>,
): Promise<LoggingSettings> {
  const writes: Array<[string, unknown]> = []

  if (patch.store !== undefined) {
    const store = patch.store.trim()
    if (!store) throw new Error('A log store is required.')
    writes.push([LOG_KEYS.store, store])
  }
  if (patch.retentionMonths !== undefined) {
    if (!Number.isInteger(patch.retentionMonths) || patch.retentionMonths < 0) {
      throw new Error('Log retention must be a whole number of months, or 0 to keep everything.')
    }
    writes.push([LOG_KEYS.retentionMonths, patch.retentionMonths])
  }
  if (patch.payloadMaxBytes !== undefined) {
    if (!Number.isInteger(patch.payloadMaxBytes) || patch.payloadMaxBytes < 1) {
      throw new Error('The payload cap must be a positive number of bytes.')
    }
    writes.push([LOG_KEYS.payloadMaxBytes, patch.payloadMaxBytes])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }

  return getLoggingSettings()
}
