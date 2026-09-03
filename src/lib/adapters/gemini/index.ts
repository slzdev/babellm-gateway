import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import {
  fromGenerateContent,
  fromGenerateContentStream,
  toGeminiRequest,
} from '@/lib/translate/chat-to-gemini'
import { fromEmbedContent, toEmbedParams } from '@/lib/translate/embeddings-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ChatOnlyAdapter,
  EmbeddingsResult,
  ProviderRuntime,
} from '../types'
import { createGeminiClient, listModels, type GeminiClientFactory } from './client'
import { toProviderError } from './errors'

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
): ChatOnlyAdapter {
  const client = createGeminiClient(runtime, createClient)

  /**
   * Gemini takes a caller's media url by reference, so building a request needs
   * no I/O of its own and this stays a thin wrapper over the pure translator.
   */
  function upstreamParams(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): GenerateContentParameters {
    const params = toGeminiRequest(req, ctx.upstreamModel, runtime.config)
    return { ...params, config: { ...params.config, abortSignal: ctx.signal } }
  }

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const result = await client.models.generateContent(upstreamParams(req, ctx))
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
        stream = await client.models.generateContentStream(upstreamParams(req, ctx))
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        yield* fromGenerateContentStream(stream, req, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async embed(req, ctx): Promise<EmbeddingsResult> {
      try {
        const result = await client.models.embedContent(
          toEmbedParams(req, ctx, runtime.name),
        )
        return fromEmbedContent(result, req, ctx.upstreamModel)
      } catch (err) {
        // The token-array refusal is thrown from inside this try, which costs
        // it nothing: toProviderError returns a ProviderError untouched, so the
        // 400 reaches the routing loop as the adapter meant it rather than
        // being reclassified as an upstream failure.
        throw toProviderError(err)
      }
    },

    listModels: (ctx) => listModels(client, ctx),
  }
}
