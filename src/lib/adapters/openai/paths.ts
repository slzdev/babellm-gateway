import type { ProviderConfig } from '../types'

/**
 * What the OpenAI SDK appends to `baseURL` for each endpoint. Overrides are
 * joined onto the base URL exactly the same way, so a provider whose base URL
 * is `https://api.x.ai/v1` and whose models path is `/api/models` is asked for
 * `https://api.x.ai/v1/api/models` — the base URL keeps carrying the `/v1`.
 */
export const DEFAULT_PATHS = {
  models: '/models',
  chatCompletions: '/chat/completions',
} as const

export type ProviderPaths = { -readonly [K in keyof typeof DEFAULT_PATHS]: string }

/** The `config` key each resolved path is stored under. */
const CONFIG_KEYS: Record<keyof ProviderPaths, string> = {
  models: 'modelsPath',
  chatCompletions: 'chatCompletionsPath',
}

/**
 * The one description of these fields, read by the provider forms to render
 * them and by the server actions to collect them. Keeping the list here rather
 * than in the form is what stops a third endpoint from having to be added in
 * three places.
 */
export const PATH_FIELDS = [
  {
    name: 'modelsPath',
    label: 'Models path',
    placeholder: DEFAULT_PATHS.models,
    help: 'Where this provider lists its models.',
  },
  {
    name: 'chatCompletionsPath',
    label: 'Chat completions path',
    placeholder: DEFAULT_PATHS.chatCompletions,
    help: 'Where this provider serves chat completions.',
  },
] as const

/** What a provider form submits for the fields above. */
export type ProviderPathInput = Partial<Record<(typeof PATH_FIELDS)[number]['name'], string>>

/**
 * Folds a form's path fields into a provider's stored config, returning a new
 * object. A submitted blank deletes the override; a field that was not
 * submitted at all is left alone, because the forms only render these for
 * OpenAI-shaped adapters and "not applicable" must not read as "cleared".
 *
 * Throws on an invalid path so the action can report it as a form error rather
 * than saving a provider that cannot serve a request.
 */
export function mergeProviderPaths(
  config: Record<string, unknown>,
  input: ProviderPathInput,
): Record<string, unknown> {
  const merged = { ...config }

  for (const field of PATH_FIELDS) {
    const raw = input[field.name]
    if (raw === undefined) continue

    const parsed = parseProviderPath(raw)
    if (parsed) merged[field.name] = parsed
    else delete merged[field.name]
  }

  return merged
}

/**
 * Validates a path typed into a provider form. Returns null for a blank value,
 * which means "use the default" rather than "no endpoint" — the field's
 * placeholder shows the default precisely so an empty box reads that way.
 *
 * The rejected shapes are the two that would fail silently rather than loudly:
 * an absolute URL is appended to the base URL rather than replacing it, which
 * builds nonsense like `https://api.x.ai/v1https://…`, and a query string is
 * something the SDK owns separately, so one written here would be escaped into
 * the path segment instead of being sent as a parameter.
 */
export function parseProviderPath(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (value.includes('://')) {
    throw new Error(
      `"${value}" is not a valid path: it is joined onto the provider's base URL, so give a path like "/chat/completions" rather than a full URL.`,
    )
  }
  if (value.includes('?')) {
    throw new Error(
      `"${value}" is not a valid path: query parameters cannot be set here.`,
    )
  }

  // Dropping empty segments normalises a trailing slash and a doubled leading
  // one in the same pass — `//models` would otherwise read as a
  // protocol-relative URL once joined onto the base URL.
  const normalized = `/${value.split('/').filter(Boolean).join('/')}`
  if (normalized === '/') {
    throw new Error(`"${value}" is not a valid path: it names no endpoint.`)
  }

  return normalized
}

/**
 * The effective path for each endpoint. Anything unusable in the stored config
 * falls back to the default instead of throwing: these values are validated on
 * the way in, so a bad one here means hand-edited or pre-validation data, and
 * serving that provider on the standard endpoint beats failing every request
 * to it.
 */
export function resolveProviderPaths(config: ProviderConfig): ProviderPaths {
  const resolve = (key: keyof ProviderPaths): string => {
    const stored = config[CONFIG_KEYS[key]]
    if (typeof stored !== 'string') return DEFAULT_PATHS[key]
    try {
      return parseProviderPath(stored) ?? DEFAULT_PATHS[key]
    } catch {
      return DEFAULT_PATHS[key]
    }
  }

  return {
    models: resolve('models'),
    chatCompletions: resolve('chatCompletions'),
  }
}
