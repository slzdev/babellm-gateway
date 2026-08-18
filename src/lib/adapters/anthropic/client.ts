import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import type { CatalogFields } from '@/lib/catalog/types'
import type { DiscoveredModel, ListModelsContext, ProviderRuntime } from '../types'

export type AnthropicClientFactory = (opts: ClientOptions) => Anthropic

const defaultFactory: AnthropicClientFactory = (opts) => new Anthropic(opts)

interface AnthropicCredentials {
  apiKey?: string
}

/**
 * `path` is not part of the SDK's public `RequestOptions` export surface —
 * only `ClientOptions` is re-exported from the package root — so it is
 * reached via the `Anthropic` namespace instead and widened locally rather
 * than cast to `never`, which would also erase `signal`'s type and let a
 * typo there compile silently.
 */
type RequestWithPath = Anthropic.RequestOptions & { path?: string }

/**
 * The api key goes out as `x-api-key`, which is what the SDK does with one —
 * the header this API authenticates on, unlike the bearer token the OpenAI
 * shape uses. A clone that wants a bearer instead is not supported; it would
 * need a credential form of its own.
 */
export function createAnthropicClient(
  runtime: ProviderRuntime,
  factory: AnthropicClientFactory = defaultFactory,
): Anthropic {
  const credentials = runtime.credentials as AnthropicCredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    // Failover is the gateway's job: an SDK retry would hold the request on a
    // target the routing loop has already decided to leave.
    maxRetries: 0,
  })
}

/**
 * What this endpoint reports about a model that the catalog can use. Unlike
 * an OpenAI-shaped `/v1/models`, it states limits — so this adapter, like
 * Gemini's, can fill the `discovered` layer with something.
 *
 * A field is left absent rather than nulled when the endpoint does not report
 * it: the merge layer treats absent and null the same today, but absent is the
 * encoding that will still be right when it distinguishes them.
 */
export function catalogFields(model: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {}
  if (typeof model.max_input_tokens === 'number') fields.contextWindow = model.max_input_tokens
  if (typeof model.max_tokens === 'number') fields.maxOutputTokens = model.max_tokens
  return fields
}

/**
 * `path` overrides the one the SDK hardcodes for this resource; the caller
 * resolves it because only the adapter holds the provider's config.
 */
export async function listModels(
  client: Anthropic,
  ctx: ListModelsContext,
  path: string,
): Promise<DiscoveredModel[]> {
  const page = await client.models.list({}, { signal: ctx.signal, path } as RequestWithPath)
  const models: DiscoveredModel[] = []

  for await (const model of page as AsyncIterable<Record<string, unknown>>) {
    if (typeof model?.id !== 'string' || model.id.length === 0) continue
    models.push({ id: model.id, fields: catalogFields(model), raw: model })
  }

  return models
}
