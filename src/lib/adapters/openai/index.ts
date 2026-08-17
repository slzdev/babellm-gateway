import type OpenAI from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'
import { resolveProviderPaths } from './paths'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { OpenAIClientFactory }

const FLAVOR_HINT =
  'If this provider only implements the Responses API, set its API flavor to "responses" on the Providers page.'

export function createOpenAIAdapter(
  runtime: ProviderRuntime,
  createClient?: OpenAIClientFactory,
): ProviderAdapter {
  const client = createOpenAIClient(runtime, createClient)
  const paths = resolveProviderPaths(runtime.config)

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
        return await client.chat.completions.create(params, {
          signal: ctx.signal,
          path: paths.chatCompletions,
        })
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
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
        stream = await client.chat.completions.create(params, {
          signal: ctx.signal,
          path: paths.chatCompletions,
        })
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        for await (const chunk of stream) yield chunk
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    listModels: (ctx) => listModels(client, ctx, paths.models),
  }
}
