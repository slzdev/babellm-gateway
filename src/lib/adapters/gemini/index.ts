import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import {
  fromGenerateContent,
  fromGenerateContentStream,
  toGeminiRequest,
} from '@/lib/translate/chat-to-gemini'
import {
  assertTranscribable,
  fromGenerateContent as fromGenerateContentTranscription,
  toGeminiRequest as toGeminiTranscriptionRequest,
} from '@/lib/translate/transcription-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ChatOnlyAdapter,
  ProviderAdapter,
  ProviderRuntime,
  TranscriptionResult,
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
): ChatOnlyAdapter & Pick<ProviderAdapter, 'transcribe'> {
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

    listModels: (ctx) => listModels(client, ctx),

    async transcribe(req: TranscriptionRequest, ctx: AttemptContext): Promise<TranscriptionResult> {
      // Both calls below can refuse the request outright — assertTranscribable
      // for a timestamped format or oversized audio, toGeminiTranscriptionRequest
      // (via mimeTypeFor) for a file whose media type cannot be resolved — and
      // neither refusal is a Gemini failure: no upstream call has happened yet.
      // Kept outside the try so the try wraps only the upstream call and its
      // response mapping, which is what can actually fail as an upstream
      // failure. toProviderError also rethrows a GatewayError untouched if one
      // ever did reach it (see adapters/gemini/errors.ts), so this is a
      // structural guarantee, not the only thing standing between a refusal
      // and a wrongly-retried request — but a reader should not have to go
      // check the classifier to see that.
      assertTranscribable(req, runtime.name)
      const params = await toGeminiTranscriptionRequest(req, ctx.upstreamModel)

      try {
        const result = await client.models.generateContent({
          ...params,
          config: { ...params.config, abortSignal: ctx.signal },
        })
        return fromGenerateContentTranscription(result, req)
      } catch (err) {
        throw toProviderError(err)
      }
    },
  }
}
