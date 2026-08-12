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
