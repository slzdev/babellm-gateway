import { projectModelsDev, type RegistryIndex } from './registry'
import type { RegistryNamespace } from './types'
import snapshot from './seed/models.json'

let cached: RegistryIndex | null = null
let cachedProviders: RegistryNamespace[] | null = null

/**
 * The offline floor: a vendored models.dev snapshot, parsed by the same
 * projection the live registry uses. Memoized because the document is a
 * couple of megabytes and every provider sync asks for it.
 *
 * Regenerate with `pnpm seed:refresh`. Do not hand-edit the JSON.
 */
export function loadSeed(): RegistryIndex {
  cached ??= projectModelsDev(snapshot)
  return cached
}

/**
 * The provider namespaces the snapshot knows, with their display names. The
 * projection behind loadSeed() keeps only `slug/modelId` keys and discards
 * provider metadata, so the names have to be read off the raw document here.
 */
export function loadSeedProviders(): RegistryNamespace[] {
  cachedProviders ??= Object.entries(snapshot as Record<string, unknown>)
    .map(([slug, provider]): RegistryNamespace => {
      const name = (provider as { name?: unknown } | null)?.name
      return { slug, name: typeof name === 'string' ? name : null }
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))

  return cachedProviders
}
