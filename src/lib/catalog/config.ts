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

/**
 * Validates a namespace typed into a provider form. A models.dev provider slug
 * is a single path segment — in the key `anyapi/xai/grok-4.3` the slug is
 * `anyapi` and the rest is the model id — so a value carrying a slash or a
 * space can never match. `xai/` would quietly build `xai//grok-4.3` and enrich
 * nothing, which is exactly the silent failure this field exists to prevent.
 */
export function parseRegistryNamespace(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (/[\s/]/.test(value)) {
    throw new Error(
      `"${value}" is not a valid registry namespace: it must be a single models.dev provider slug, with no slashes or spaces.`,
    )
  }

  return value
}
