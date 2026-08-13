import OpenAI, { type ClientOptions } from 'openai'
import type {
  DiscoveredModel,
  ListModelsContext,
  ProviderRuntime,
} from '../types'

export type OpenAIClientFactory = (opts: ClientOptions) => OpenAI

const defaultFactory: OpenAIClientFactory = (opts) => new OpenAI(opts)

interface OpenAICredentials {
  apiKey?: string
  organization?: string
  project?: string
}

/**
 * Both flavors authenticate identically and differ only in which endpoint they
 * call, so client construction is shared rather than duplicated per adapter.
 */
export function createOpenAIClient(
  runtime: ProviderRuntime,
  factory: OpenAIClientFactory = defaultFactory,
): OpenAI {
  const credentials = runtime.credentials as OpenAICredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    ...(credentials.organization ? { organization: credentials.organization } : {}),
    ...(credentials.project ? { project: credentials.project } : {}),
    maxRetries: 0,
  })
}

/**
 * `GET /v1/models` is a third endpoint, served by Chat Completions and
 * Responses providers alike, so model discovery is identical for both flavors
 * and the catalog never has to know which one it is talking to.
 *
 * `path` overrides the one the SDK hardcodes for this resource; the caller
 * resolves it because only the adapter holds the provider's config.
 */
export async function listModels(
  client: OpenAI,
  ctx: ListModelsContext,
  path: string,
): Promise<DiscoveredModel[]> {
  const page = await client.models.list({ signal: ctx.signal, path })
  const models: DiscoveredModel[] = []

  for await (const model of page) {
    // Some openai_compatible clones return entries with no id at all.
    if (typeof model?.id !== 'string' || model.id.length === 0) continue
    // /v1/models reports id, created and owned_by — nothing the catalog
    // can merge. Enrichment comes from the registry and seed layers.
    models.push({ id: model.id, fields: {}, raw: model })
  }

  return models
}
