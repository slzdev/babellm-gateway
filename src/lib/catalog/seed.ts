import { projectModelsDev, type RegistryIndex } from './registry'
import snapshot from './seed/models.json'

let cached: RegistryIndex | null = null

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
