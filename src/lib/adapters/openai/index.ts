import OpenAI, { type ClientOptions } from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  DiscoveredModel,
  ListModelsContext,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { toProviderError } from './errors'

export type OpenAIClientFactory = (opts: ClientOptions) => OpenAI

const defaultFactory: OpenAIClientFactory = (opts) => new OpenAI(opts)

interface OpenAICredentials {
  apiKey?: string
  organization?: string
  project?: string
}

export function createOpenAIAdapter(
  runtime: ProviderRuntime,
  createClient: OpenAIClientFactory = defaultFactory,
): ProviderAdapter {
  const credentials = runtime.credentials as OpenAICredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  const client = createClient({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    ...(credentials.organization ? { organization: credentials.organization } : {}),
    ...(credentials.project ? { project: credentials.project } : {}),
    maxRetries: 0,
  })

  function upstreamParams(req: ChatCompletionRequest, ctx: AttemptContext) {
    return { ...req, model: ctx.upstreamModel }
  }

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      const params = {
        ...upstreamParams(req, ctx),
        stream: false as const,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

      try {
        return await client.chat.completions.create(params, { signal: ctx.signal })
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      const base = upstreamParams(req, ctx)
      const streamOptions = runtime.config.disableStreamUsage
        ? {}
        : { stream_options: { include_usage: true, ...(base.stream_options ?? {}) } }

      const params = {
        ...base,
        ...streamOptions,
        stream: true as const,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway
      // has committed a response, the second after. Both must arrive at the
      // routing loop already interpreted.
      let stream
      try {
        stream = await client.chat.completions.create(params, { signal: ctx.signal })
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        for await (const chunk of stream) yield chunk
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async listModels(ctx: ListModelsContext): Promise<DiscoveredModel[]> {
      const page = await client.models.list({ signal: ctx.signal })
      const models: DiscoveredModel[] = []

      for await (const model of page) {
        // Some openai_compatible clones return entries with no id at all.
        if (typeof model?.id !== 'string' || model.id.length === 0) continue
        // /v1/models reports id, created and owned_by — nothing the catalog
        // can merge. Enrichment comes from the registry and seed layers.
        models.push({ id: model.id, fields: {}, raw: model })
      }

      return models
    },
  }
}
