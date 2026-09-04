import type { ProviderConfig } from './types'

/**
 * What the OpenAI SDK appends to `baseURL` for each endpoint. These are the
 * only paths that are ever joined onto the base URL: an override is read as
 * absolute on the base URL's host instead, so a provider whose base URL is
 * `https://example.com/gwt/v1` and whose chat completions path is
 * `/openai/v1/chat/completions` is asked for
 * `https://example.com/openai/v1/chat/completions` — the `/gwt/v1` is
 * replaced, not carried. See resolveRequestPaths.
 */
export const DEFAULT_PATHS = {
  models: '/models',
  chatCompletions: '/chat/completions',
  responses: '/responses',
  // Relative like the others, so a base URL that carries its own `/v1`
  // still resolves correctly. The Anthropic SDK's own default is the
  // absolute `/v1/messages`; the adapter always passes an explicit path,
  // so that default never applies and cannot double the prefix.
  messages: '/messages',
  audioTranscriptions: '/audio/transcriptions',
  embeddings: '/embeddings',
} as const

export type ProviderPaths = { -readonly [K in keyof typeof DEFAULT_PATHS]: string }

/** The `config` key each resolved path is stored under. */
const CONFIG_KEYS: Record<keyof ProviderPaths, string> = {
  models: 'modelsPath',
  chatCompletions: 'chatCompletionsPath',
  responses: 'responsesPath',
  messages: 'messagesPath',
  audioTranscriptions: 'audioTranscriptionsPath',
  embeddings: 'embeddingsPath',
}

/**
 * The one description of these fields, read by the provider forms to render
 * them and by the server actions to collect them. Keeping the list here rather
 * than in the form is what stops each new endpoint from having to be added in
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
  {
    name: 'responsesPath',
    label: 'Responses path',
    placeholder: DEFAULT_PATHS.responses,
    help: 'Where this provider serves the Responses API.',
  },
  {
    name: 'messagesPath',
    label: 'Messages path',
    placeholder: DEFAULT_PATHS.messages,
    help: 'Where this provider serves the Anthropic Messages API.',
  },
  {
    name: 'audioTranscriptionsPath',
    label: 'Audio transcriptions path',
    placeholder: DEFAULT_PATHS.audioTranscriptions,
    help: 'Where this provider transcribes audio.',
  },
  {
    name: 'embeddingsPath',
    label: 'Embeddings path',
    placeholder: DEFAULT_PATHS.embeddings,
    help: 'Where this provider serves embeddings.',
  },
] as const

/**
 * The fields a single model may override, for the catalog's gateway dialog.
 * Written out rather than filtered from PATH_FIELDS because the help text is
 * what differs: on a provider form these describe where the provider serves
 * everything, and here they describe one model departing from that.
 */
export const MODEL_PATH_FIELDS = [
  {
    name: 'chatCompletionsPath',
    label: 'Chat completions path',
    placeholder: DEFAULT_PATHS.chatCompletions,
    help: 'Where this one model is served, if not where the provider serves the rest.',
  },
  {
    name: 'responsesPath',
    label: 'Responses path',
    placeholder: DEFAULT_PATHS.responses,
    help: 'Where this one model answers the Responses API.',
  },
  {
    name: 'messagesPath',
    label: 'Messages path',
    placeholder: DEFAULT_PATHS.messages,
    help: 'Where this one model answers the Anthropic Messages API.',
  },
  {
    name: 'audioTranscriptionsPath',
    label: 'Audio transcriptions path',
    placeholder: DEFAULT_PATHS.audioTranscriptions,
    help: 'Where this one model is transcribed, if not where the provider serves the rest.',
  },
  {
    name: 'embeddingsPath',
    label: 'Embeddings path',
    placeholder: DEFAULT_PATHS.embeddings,
    help: 'Where this one model is embedded, if not where the provider embeds the rest.',
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
 * a full URL would let a form move a provider to another host, which is what
 * the base URL is for and where its credentials would then be sent, and a
 * query string is something the SDK owns separately, so one written here would
 * be escaped into the path segment instead of being sent as a parameter.
 */
export function parseProviderPath(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (value.includes('://')) {
    throw new Error(
      `"${value}" is not a valid path: it is served from the provider's own host, so give a path like "/chat/completions" rather than a full URL.`,
    )
  }
  if (value.includes('?')) {
    throw new Error(
      `"${value}" is not a valid path: query parameters cannot be set here.`,
    )
  }

  // Dropping empty segments normalises a trailing slash and a doubled leading
  // one in the same pass — `//models` would otherwise read as a
  // protocol-relative URL, and resolve against a host of its own.
  const normalized = `/${value.split('/').filter(Boolean).join('/')}`
  if (normalized === '/') {
    throw new Error(`"${value}" is not a valid path: it names no endpoint.`)
  }

  return normalized
}

/**
 * The path configured for each endpoint, as a path — what the dashboard shows
 * and what a model's placeholder inherits. Anything unusable in the stored
 * config falls back to the default instead of throwing: these values are
 * validated on the way in, so a bad one here means hand-edited or
 * pre-validation data, and serving that provider on the standard endpoint
 * beats failing every request to it.
 *
 * Use resolveRequestPaths, not this, to build a request.
 */
export function resolveProviderPaths(config: ProviderConfig): ProviderPaths {
  return {
    models: resolveOne(config, 'models').path,
    chatCompletions: resolveOne(config, 'chatCompletions').path,
    responses: resolveOne(config, 'responses').path,
    messages: resolveOne(config, 'messages').path,
    audioTranscriptions: resolveOne(config, 'audioTranscriptions').path,
    embeddings: resolveOne(config, 'embeddings').path,
  }
}

/**
 * What to hand the SDK as its per-request `path`, which it uses verbatim when
 * it is a full URL and appends to `baseURL` otherwise. That difference is the
 * mechanism behind the two rules this encodes:
 *
 * - An endpoint nobody configured stays a relative path, so the base URL keeps
 *   carrying its own prefix and `https://api.x.ai/v1` still means
 *   `https://api.x.ai/v1/chat/completions`.
 * - A configured one is resolved against the base URL's origin, so it names the
 *   whole path: a gateway reachable at `https://example.com/gwt/v1` that serves
 *   the OpenAI shape from `/openai/v1/chat/completions` is asked for exactly
 *   that, not for `/gwt/v1/openai/v1/chat/completions`.
 *
 * The host always comes from the base URL — an override cannot move a provider
 * elsewhere, which is why parseProviderPath refuses a full URL.
 *
 * A provider with no base URL, or one that cannot be parsed, keeps the relative
 * path: there is no origin to resolve against, and the SDK joining it onto its
 * own default beats sending nothing.
 */
export function resolveRequestPaths(
  config: ProviderConfig,
  baseUrl: string | null | undefined,
): ProviderPaths {
  const origin = parseOrigin(baseUrl)

  const resolve = (key: keyof ProviderPaths): string => {
    const { path, custom } = resolveOne(config, key)
    return custom && origin ? new URL(path, origin).toString() : path
  }

  return {
    models: resolve('models'),
    chatCompletions: resolve('chatCompletions'),
    responses: resolve('responses'),
    messages: resolve('messages'),
    audioTranscriptions: resolve('audioTranscriptions'),
    embeddings: resolve('embeddings'),
  }
}

/**
 * `custom` is what separates "the admin typed this" from "nothing was
 * configured", which is the only thing that decides whether the base URL's
 * prefix survives. A stored value that is unusable counts as neither — it
 * falls back to the default, and the default is never absolute.
 */
function resolveOne(
  config: ProviderConfig,
  key: keyof ProviderPaths,
): { path: string; custom: boolean } {
  const fallback = { path: DEFAULT_PATHS[key], custom: false }
  const stored = config[CONFIG_KEYS[key]]
  if (typeof stored !== 'string') return fallback

  try {
    const parsed = parseProviderPath(stored)
    return parsed ? { path: parsed, custom: true } : fallback
  } catch {
    return fallback
  }
}

function parseOrigin(baseUrl: string | null | undefined): string | null {
  if (!baseUrl?.trim()) return null
  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}
