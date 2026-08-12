import OpenAI, { type ClientOptions } from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'

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
      const params = { ...upstreamParams(req, ctx), stream: false as const }
      return (await client.chat.completions.create(params as never, {
        signal: ctx.signal,
      })) as ChatCompletion
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      const base = upstreamParams(req, ctx)
      const streamOptions = runtime.config.disableStreamUsage
        ? {}
        : { stream_options: { include_usage: true, ...(base.stream_options ?? {}) } }

      const stream = (await client.chat.completions.create(
        { ...base, ...streamOptions, stream: true } as never,
        { signal: ctx.signal },
      )) as unknown as AsyncIterable<ChatCompletionChunk>

      for await (const chunk of stream) yield chunk
    },
  }
}
