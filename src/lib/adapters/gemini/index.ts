import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import {
  fromGenerateContent,
  fromGenerateContentStream,
  toGeminiRequest,
} from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createGeminiClient, listModels, type GeminiClientFactory } from './client'
import { toProviderError } from './errors'
import { resolveMedia } from './media'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { GeminiClientFactory }

/**
 * A provider that speaks Google's generateContent API. It holds no translation
 * logic of its own — that lives in the pure module, which is what makes it
 * testable without a client — and satisfies the same ProviderAdapter contract
 * as the OpenAI-shaped adapters, so the routing loop never learns that a third
 * protocol exists.
 */
export function createGeminiAdapter(
  runtime: ProviderRuntime,
  createClient?: GeminiClientFactory,
): ProviderAdapter {
  const client = createGeminiClient(runtime, createClient)

  /**
   * Media resolution is the one part of building a request that does I/O, so it
   * happens here rather than inside the translator, which stays pure.
   */
  async function upstreamParams(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): Promise<GenerateContentParameters> {
    const media = await resolveMedia(req.messages, {
      client,
      signal: ctx.signal,
      requestId: ctx.requestId,
    })
    const params = toGeminiRequest(req, ctx.upstreamModel, media, runtime.config)
    return { ...params, config: { ...params.config, abortSignal: ctx.signal } }
  }

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const result = await client.models.generateContent(await upstreamParams(req, ctx))
        return fromGenerateContent(result, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream: AsyncGenerator<GenerateContentResponse>
      try {
        stream = await client.models.generateContentStream(await upstreamParams(req, ctx))
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        yield* fromGenerateContentStream(stream, req, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    listModels: (ctx) => listModels(client, ctx),
  }
}
