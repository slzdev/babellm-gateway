import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { ProviderError } from '@/lib/gateway/errors'
import { fromConverse, fromConverseStream, toConverseRequest } from '@/lib/translate/chat-to-bedrock'
import type { ChatOnlyAdapter, ProviderRuntime } from '../types'
import { createBedrockControlClient, createBedrockRuntimeClient, type BedrockClientFactory } from './client'
import { listModels } from './discovery'
import { toProviderError } from './errors'

export type { BedrockClientFactory }

export function createBedrockAdapter(runtime: ProviderRuntime, factory?: BedrockClientFactory): ChatOnlyAdapter {
  const client = createBedrockRuntimeClient(runtime, factory?.runtime)
  const timeoutMs = runtime.config.timeoutMs ?? 120_000
  const options = (signal: AbortSignal) => ({
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    requestTimeout: timeoutMs,
  })
  return {
    async chat(req, ctx) {
      try {
        const output = await client.send(new ConverseCommand(toConverseRequest(req, ctx.upstreamModel)), options(ctx.signal))
        return fromConverse(output, ctx.upstreamModel)
      } catch (err) { throw toProviderError(err) }
    },
    async *chatStream(req, ctx) {
      try {
        // The total-duration signal stays active while draining the stream;
        // HTTP/2 requestTimeout alone is only an idle timeout.
        const output = await client.send(new ConverseStreamCommand(toConverseRequest(req, ctx.upstreamModel)), options(ctx.signal))
        if (!output.stream) throw new ProviderError({ status: 502, message: 'Bedrock returned no response stream.', retryable: true })
        yield* fromConverseStream(output.stream, req, ctx.upstreamModel)
      } catch (err) { throw toProviderError(err) }
    },
    async listModels(ctx) {
      try {
        return await listModels(createBedrockControlClient(runtime, factory?.control), ctx)
      } catch (err) { throw toProviderError(err) }
    },
  }
}
