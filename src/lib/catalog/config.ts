import 'server-only'

/**
 * Parses a provider's `config` TEXT column defensively — malformed JSON, or a
 * structurally valid but non-object body (`"null"`, `"[]"`, `"3"`), reads as
 * empty rather than throwing or being dereferenced.
 *
 * The one implementation, shared by `lib/catalog` and `lib/admin` so it stops
 * drifting between copies.
 */
export function parseProviderConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readRegistryNamespace(config: string): string | null {
  const parsed = parseProviderConfig(config)
  return typeof parsed.registryNamespace === 'string' ? parsed.registryNamespace : null
}
