import { GoogleGenAI, type GoogleGenAIOptions, type Model } from '@google/genai'
import type { CatalogFields } from '@/lib/catalog/types'
import type { DiscoveredModel, ListModelsContext, ProviderRuntime } from '../types'

export type GeminiClientFactory = (opts: GoogleGenAIOptions) => GoogleGenAI

const defaultFactory: GeminiClientFactory = (opts) => new GoogleGenAI(opts)

interface GeminiCredentials {
  apiKey?: string
}

/**
 * The Gemini Developer API, always: `vertexai`, `project` and `location` are
 * never set, because Vertex needs service-account OAuth rather than the api key
 * this provider's credential schema stores.
 *
 * `baseUrl` is honoured when a provider carries one so a proxy can be pointed
 * at, but the provider form does not offer it — nothing in the UI implies a
 * Gemini provider is configurable that way.
 */
export function createGeminiClient(
  runtime: ProviderRuntime,
  factory: GeminiClientFactory = defaultFactory,
): GoogleGenAI {
  const credentials = runtime.credentials as GeminiCredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { httpOptions: { baseUrl: runtime.baseUrl } } : {}),
  })
}

/**
 * What Gemini reports about a model that the catalog can actually use. This is
 * the first adapter to fill the `discovered` layer with anything: `/v1/models`
 * on an OpenAI-shaped provider reports an id and nothing else.
 *
 * A field is left absent rather than nulled when Gemini does not report it.
 * The merge layer treats absent and null the same today, but absent is the
 * encoding that will still be right when it distinguishes them.
 */
export function catalogFields(model: Model): CatalogFields {
  const actions = model.supportedActions ?? []
  const fields: CatalogFields = {}

  if (typeof model.inputTokenLimit === 'number') fields.contextWindow = model.inputTokenLimit
  if (typeof model.outputTokenLimit === 'number') fields.maxOutputTokens = model.outputTokenLimit

  if (actions.length > 0) {
    fields.supportsStreaming = actions.includes('streamGenerateContent')
    if (actions.includes('generateContent')) fields.kind = 'chat'
    else if (actions.includes('embedContent')) fields.kind = 'embedding'
  }

  return fields
}

/**
 * `queryBase: true` is already the SDK's default for `Models.list` in this
 * version, so passing it explicitly pins that default rather than changing
 * behaviour — cheap insurance if the default ever moves. The `false` path
 * only matters under Vertex, which this adapter never enters.
 */
export async function listModels(
  client: GoogleGenAI,
  ctx: ListModelsContext,
): Promise<DiscoveredModel[]> {
  const pager = await client.models.list({
    config: { queryBase: true, abortSignal: ctx.signal },
  })

  const models: DiscoveredModel[] = []
  for await (const model of pager) {
    if (typeof model.name !== 'string' || model.name.length === 0) continue
    // Stored without the prefix so direct addressing reads
    // `google/gemini-2.5-flash`. canonicalKeyCandidates already tries both
    // forms, so a hand-entered prefixed id still matches models.dev.
    models.push({
      id: model.name.replace(/^models\//, ''),
      fields: catalogFields(model),
      raw: model,
    })
  }

  return models
}
