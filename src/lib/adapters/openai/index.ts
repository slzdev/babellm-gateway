import type OpenAI from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ChatOnlyAdapter,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'
import { transcribeVia } from './audio'
import { resolveRequestPaths } from '../paths'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { OpenAIClientFactory }

const FLAVOR_HINT =
  'If this endpoint implements the Responses API or the Anthropic Messages API instead, set the model\'s API flavor accordingly on the Catalog page — or the provider\'s, if every model should follow it.'

export function createOpenAIAdapter(
  runtime: ProviderRuntime,
  createClient?: OpenAIClientFactory,
): ChatOnlyAdapter & Pick<ProviderAdapter, 'transcribe'> {
  const client = createOpenAIClient(runtime, createClient)
  const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)

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

    // /audio/transcriptions is a sibling endpoint on the same host, not a
    // dialect of chat — see design doc §3.4 — so it is served the same way
    // regardless of which flavor this provider's chat endpoint speaks.
    transcribe: transcribeVia(client, paths.audioTranscriptions),
  }
}
