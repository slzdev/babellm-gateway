import type { AdapterType } from '@/lib/adapters/credentials'

/**
 * models.dev keys every model under a provider slug. These are the defaults
 * per adapter; `openai_compatible` has none, because the endpoint behind it
 * could be anything (and ollama has no models.dev namespace at all), so its
 * provider config must name one via `registryNamespace`.
 */
export const REGISTRY_NAMESPACE: Record<AdapterType, string | null> = {
  openai: 'openai',
  openai_compatible: null,
  gemini: 'google',
  bedrock: 'amazon-bedrock',
}

// One list defines the concept: the strip pattern is derived from it, so
// the two directions cannot drift apart.
const BEDROCK_REGIONS = ['us', 'eu', 'apac', 'global'] as const
const BEDROCK_REGION_PREFIX = new RegExp(`^(?:${BEDROCK_REGIONS.join('|')})\\.`)
const OPENAI_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

/** Bare model ids to try, most specific first, before namespacing. */
function idCandidates(adapter: AdapterType, modelId: string): string[] {
  const ids = [modelId]

  switch (adapter) {
    case 'openai': {
      const undated = modelId.replace(OPENAI_DATE_SUFFIX, '')
      if (undated !== modelId) ids.push(undated)
      break
    }
    case 'gemini': {
      const bare = modelId.replace(/^models\//, '')
      if (bare !== modelId) ids.push(bare)
      break
    }
    case 'bedrock': {
      const unregioned = modelId.replace(BEDROCK_REGION_PREFIX, '')
      if (unregioned !== modelId) ids.push(unregioned)
      else for (const region of BEDROCK_REGIONS) ids.push(`${region}.${modelId}`)
      break
    }
    case 'openai_compatible':
      break
  }

  return ids
}

/**
 * Candidate models.dev keys for one discovered model, in the order they should
 * be tried. An empty array means the model cannot be matched, which is a real
 * and expected outcome — the UI surfaces it so an admin can set a namespace or
 * enter an override.
 */
export function canonicalKeyCandidates(
  adapter: AdapterType,
  modelId: string,
  registryNamespace?: string | null,
): string[] {
  const namespace = registryNamespace?.trim() || REGISTRY_NAMESPACE[adapter]
  const keys: string[] = []

  if (namespace) {
    for (const id of idCandidates(adapter, modelId)) keys.push(`${namespace}/${id}`)
  }

  // An id that already carries a vendor segment ("openai/gpt-4o" from an
  // OpenRouter-style proxy) may match another namespace directly.
  if (adapter === 'openai_compatible' && modelId.includes('/')) keys.push(modelId)

  return [...new Set(keys)]
}
