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
  ResponsesResult,
  ResponseStreamEvent,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'
import { resolveRequestPaths } from '../paths'

// The symmetric misconfiguration to the Chat Completions hint below: a
// provider set to `responses` that in fact speaks Chat Completions or
// Anthropic Messages instead. The dashboard makes this exactly as reachable
// as the reverse mistake, so it gets the same treatment.
const FLAVOR_HINT =
  'If this endpoint implements the Chat Completions API or the Anthropic Messages API instead, set the model\'s API flavor accordingly on the Catalog page — or the provider\'s, if every model should follow it.'

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
  const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)

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

    /**
     * The matching path: Responses in, Responses out. No translation at all —
     * which is the whole reason this pair exists rather than the ingress
     * normalising to Chat Completions. Hosted tools, reasoning items and
     * encrypted content survive only here.
     */
    async respond(req, ctx): Promise<ResponsesResult> {
      try {
        return await client.responses.create(
          // The cast is a type assertion only — `include` and friends are
          // typed loosely in the gateway's own schema (new values ship faster
          // than this would be updated) but forwarded exactly as received.
          { ...req, model: ctx.upstreamModel, stream: false } as OpenAI.Responses.ResponseCreateParamsNonStreaming,
          { signal: ctx.signal, path: paths.responses },
        ) as ResponsesResult
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    async *respondStream(req, ctx): AsyncIterable<ResponseStreamEvent> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream
      try {
        stream = await client.responses.create(
          { ...req, model: ctx.upstreamModel, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
          { signal: ctx.signal, path: paths.responses },
        )
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        for await (const event of stream as AsyncIterable<ResponseStreamEvent>) yield event
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },
  }
}
