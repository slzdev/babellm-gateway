import type OpenAI from 'openai'
import {
  fromResponse,
  fromResponseStream,
  toResponsesRequest,
} from '@/lib/translate/chat-to-responses'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'
import { resolveProviderPaths } from './paths'

// The symmetric misconfiguration to the Chat Completions hint below: a
// provider set to `responses` that in fact only speaks Chat Completions. The
// dashboard makes this exactly as reachable as the reverse mistake, so it
// gets the same treatment.
const FLAVOR_HINT =
  'If this provider only implements the Chat Completions API, set its API flavor to "chat_completions" on the Providers page.'

/**
 * A provider that serves /v1/responses but not /v1/chat/completions. It holds
 * no translation logic of its own — that lives in the pure module, which is
 * what makes it testable without a client — and satisfies the same
 * ProviderAdapter contract as the Chat Completions adapter, so the routing loop
 * never learns that two protocols exist.
 */
export function createResponsesAdapter(
  runtime: ProviderRuntime,
  createClient?: OpenAIClientFactory,
): ProviderAdapter {
  const client = createOpenAIClient(runtime, createClient)
  const paths = resolveProviderPaths(runtime.config)

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const result = await client.responses.create(
          {
            ...toResponsesRequest(req, ctx.upstreamModel, runtime.config),
            stream: false,
          },
          { signal: ctx.signal, path: paths.responses },
        )
        return fromResponse(result as OpenAI.Responses.Response)
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream
      try {
        stream = await client.responses.create(
          {
            ...toResponsesRequest(req, ctx.upstreamModel, runtime.config),
            stream: true,
          },
          { signal: ctx.signal, path: paths.responses },
        )
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        yield* fromResponseStream(
          stream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
          req,
        )
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    listModels: (ctx) => listModels(client, ctx, paths.models),
  }
}
