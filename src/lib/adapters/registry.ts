import type { ApiFlavor } from '@/lib/api-flavors'
import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createAnthropicAdapter } from './anthropic'
import { createGeminiAdapter } from './gemini'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './openai/responses'
import type {
  ModelPathOverrides, ProviderAdapter, ProviderConfig, ProviderRuntime,
} from './types'
import { withEmbedUnsupported, withRespondViaChat, withTranscribeUnsupported } from './wrappers'

export function resolveProviderRuntime(provider: ProviderRow): ProviderRuntime {
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    credentials: decryptJson<Record<string, unknown>>(provider.credentials),
    config: JSON.parse(provider.config) as ProviderConfig,
  }
}

export function createAdapter(
  provider: ProviderRow,
  flavor: ApiFlavor = provider.apiFlavor,
  paths?: ModelPathOverrides | null,
  maxOutputTokens?: number | null,
): ProviderAdapter {
  const runtime = withModelPaths(resolveProviderRuntime(provider), paths)

  switch (runtime.adapter) {
    case 'openai':
      return flavoredAdapter(runtime, flavor, maxOutputTokens ?? null)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return flavoredAdapter(runtime, flavor, maxOutputTokens ?? null)
    case 'gemini':
      // Gemini speaks neither OpenAI dialect natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way,
      // and gets `respond`/`respondStream` from the same wrapper any
      // chat-only adapter does. `transcribe` and `embed` are both real and
      // translated (transcriptions §3.6, embeddings §3.4) —
      // createGeminiAdapter supplies them directly, so neither
      // `withTranscribeUnsupported` nor `withEmbedUnsupported` belongs here.
      return withRespondViaChat(createGeminiAdapter(runtime), runtime.name)
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}

/**
 * Layers a model's paths over its provider's. Only the keys the model actually
 * names are copied, so an unset one falls through to the provider — and
 * `modelsPath` is not among them, because listing models is a provider
 * operation that happens with no model in hand.
 */
export function withModelPaths(
  runtime: ProviderRuntime,
  paths: ModelPathOverrides | null | undefined,
): ProviderRuntime {
  if (
    !paths?.chatCompletionsPath && !paths?.responsesPath && !paths?.messagesPath
    && !paths?.audioTranscriptionsPath && !paths?.embeddingsPath
  ) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  if (paths.messagesPath) config.messagesPath = paths.messagesPath
  if (paths.audioTranscriptionsPath) config.audioTranscriptionsPath = paths.audioTranscriptionsPath
  if (paths.embeddingsPath) config.embeddingsPath = paths.embeddingsPath
  return { ...runtime, config }
}

/**
 * Dispatches on the flavor the model resolved to. Two of the three branches
 * need `withRespondViaChat`; the Responses adapter already implements
 * chat/chatStream through chat-to-responses.ts and is returned as-is.
 */
function flavoredAdapter(
  runtime: ProviderRuntime,
  flavor: ApiFlavor,
  maxOutputTokens: number | null,
): ProviderAdapter {
  if (flavor === 'responses') return createResponsesAdapter(runtime)
  if (flavor === 'anthropic_messages') {
    // The one true exception, and it is the exception twice over: Anthropic's
    // own API has neither a transcription endpoint nor an embeddings one,
    // regardless of which adapter reaches it. Unlike the Gemini branch above,
    // neither is a placeholder — both throws are permanent, and each
    // ingress's all-ineligible fallback means both are reachable through the
    // gateway: a model whose only target is `anthropic_messages` reaches this
    // adapter and gets one of these throws as its 501.
    return withEmbedUnsupported(
      withTranscribeUnsupported(
        withRespondViaChat(createAnthropicAdapter(runtime, maxOutputTokens), runtime.name),
        runtime.name,
        'the Anthropic Messages API has no transcription endpoint and no audio input at all',
      ),
      runtime.name,
      'the Anthropic Messages API has no embeddings endpoint',
    )
  }
  return withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
