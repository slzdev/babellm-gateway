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
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_PAYLOAD_MAX_BYTES = 262_144

export interface LoggingSettings {
  store: string
  /** 0 disables pruning. */
  retentionDays: number
  payloadMaxBytes: number
}

const LOG_KEYS = {
  store: 'logs.store',
  retentionDays: 'logs.retention_days',
  payloadMaxBytes: 'logs.payload_max_bytes',
} as const

export async function getLoggingSettings(): Promise<LoggingSettings> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const store = byKey.get(LOG_KEYS.store)
  const retention = byKey.get(LOG_KEYS.retentionDays)
  const cap = byKey.get(LOG_KEYS.payloadMaxBytes)

  return {
    store: typeof store === 'string' && store.length > 0 ? store : DEFAULT_LOG_STORE,
    retentionDays:
      typeof retention === 'number' && retention >= 0 ? retention : DEFAULT_RETENTION_DAYS,
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
  if (patch.retentionDays !== undefined) {
    if (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 0) {
      throw new Error('Log retention must be a whole number of days, or 0 to keep everything.')
    }
    writes.push([LOG_KEYS.retentionDays, patch.retentionDays])
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
