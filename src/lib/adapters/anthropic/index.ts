import type Anthropic from '@anthropic-ai/sdk'
import {
  fromMessage,
  fromMessageStream,
  toMessagesRequest,
} from '@/lib/translate/chat-to-anthropic'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatOnlyAdapter,
  ProviderRuntime,
} from '../types'
import { resolveRequestPaths } from '../paths'
import { createAnthropicClient, listModels, type AnthropicClientFactory } from './client'
import { toProviderError } from './errors'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { AnthropicClientFactory }

// `path` is not part of the SDK's public `RequestOptions` export surface —
// only `ClientOptions` is re-exported from the package root — so it is
// reached via the `Anthropic` namespace instead and widened locally rather
// than cast to `never`, which would also erase `signal`'s type and let a
// typo there compile silently. Mirrors the alias declared in ./client.
type RequestWithPath = Anthropic.RequestOptions & { path?: string }

// The counterpart to the two OpenAI-shaped hints: a model set to
// anthropic_messages whose endpoint in fact speaks an OpenAI dialect.
const FLAVOR_HINT =
  'If this endpoint does not implement the Anthropic Messages API, set the model\'s API flavor to "chat_completions" or "responses" on the Catalog page — or the provider\'s, if every model should follow it.'

/**
 * A provider that serves the Anthropic Messages API. It holds no translation
 * logic of its own — that lives in the pure module, which is what makes it
 * testable without a client — and satisfies the ChatOnlyAdapter contract, so
 * the registry gives it `respond`/`respondStream` from the same wrapper every
 * chat-only adapter uses and the routing loop never learns a fourth protocol
 * exists.
 *
 * `maxOutputTokens` is the model's catalogued ceiling, passed in because this
 * API requires `max_tokens` and Chat Completions does not. An adapter is
 * constructed per attempt and an attempt is always for one model, so it can be
 * closed over here rather than threaded through every call.
 */
export function createAnthropicAdapter(
  runtime: ProviderRuntime,
  maxOutputTokens: number | null = null,
  createClient?: AnthropicClientFactory,
): ChatOnlyAdapter {
  const client = createAnthropicClient(runtime, createClient)
  const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const message = await client.messages.create(
          {
            ...toMessagesRequest(req, ctx.upstreamModel, runtime.config, maxOutputTokens),
            stream: false,
          },
          { signal: ctx.signal, path: paths.messages } as RequestWithPath,
        )
        return fromMessage(message as Anthropic.Message, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the
      // routing loop already interpreted.
      let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>
      try {
        stream = (await client.messages.create(
          {
            ...toMessagesRequest(req, ctx.upstreamModel, runtime.config, maxOutputTokens),
            stream: true,
          },
          { signal: ctx.signal, path: paths.messages } as RequestWithPath,
        )) as AsyncIterable<Anthropic.RawMessageStreamEvent>
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        yield* fromMessageStream(stream, req, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    listModels: (ctx) => listModels(client, ctx, paths.models),
  }
}
