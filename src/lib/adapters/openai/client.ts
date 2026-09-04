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
 * `path` overrides the one the SDK hardcodes for this resource; the caller
 * resolves it because only the adapter holds the provider's config.
 *
 * `embeddingsModelsPath`, when given, is a second listing asked for after the
 * first — see the comment on mergeEmbeddingsModels for what it is and why a
 * model is only ever added from it, never reinterpreted by it.
 */
export async function listModels(
  client: OpenAI,
  ctx: ListModelsContext,
  path: string,
  embeddingsModelsPath?: string | null,
): Promise<DiscoveredModel[]> {
  const models = await listFrom(client, ctx, path)
  if (!embeddingsModelsPath) return models

  let embeddingsModels: DiscoveredModel[]
  try {
    embeddingsModels = await listFrom(client, ctx, embeddingsModelsPath)
  } catch {
    // Expected, and for most providers the only outcome: nothing but
    // OpenRouter serves this path, so a 404 here is the norm and says only
    // that this provider keeps every model in one listing. The sync's own
    // result must not turn on it — the first listing already succeeded.
    return models
  }

  return mergeEmbeddingsModels(models, embeddingsModels)
}

/**
 * Folds an embeddings-only listing into the main one. Two rules, and the
 * second is the load-bearing one:
 *
 * - A model the main listing never mentioned is added, tagged `embedding`.
 *   That is the whole point: OpenRouter's `/models` omits its embeddings
 *   models, so without this they reach the catalog not at all.
 * - A model both listings report is left exactly as the main listing gave it.
 *   The path is asked for unconditionally, so a clone whose router answers any
 *   `/models`-ish path with its full catalog would otherwise have every model
 *   it serves relabelled `embedding` — and a mislabelled chat model is worse
 *   than a missing embeddings one, because routing believes the label.
 */
export function mergeEmbeddingsModels(
  models: DiscoveredModel[],
  embeddingsModels: DiscoveredModel[],
): DiscoveredModel[] {
  const known = new Set(models.map((model) => model.id))

  const added = embeddingsModels.filter((model) => {
    if (known.has(model.id)) return false
    // A listing that repeats an id would otherwise add it twice.
    known.add(model.id)
    return true
  })

  return [
    ...models,
    // The endpoint is the evidence: everything it lists is an embeddings
    // model, whatever its id looks like. This is the one thing an
    // OpenAI-shaped listing can say about a model, so it is the one field set
    // — prices and context windows still come from the registry and seed.
    ...added.map((model) => ({ ...model, fields: { kind: 'embedding' as const } })),
  ]
}

async function listFrom(
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
