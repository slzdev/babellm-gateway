import type { DecisionsApiFlavor } from '@/lib/decisions-api-flavors'
import type { ApiFlavor } from '@/lib/api-flavors'
import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createAnthropicAdapter } from './anthropic'
import { createGeminiAdapter } from './gemini'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './openai/responses'
import { createDecisionsOperation } from './openai/decisions'
import type {
  ModelPathOverrides, ProviderAdapter, ProviderConfig, ProviderRuntime,
} from './types'
import { withDecideUnsupported, withEmbedUnsupported, withRespondViaChat, withTranscribeUnsupported } from './wrappers'

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
  decisionsApiFlavor: DecisionsApiFlavor = provider.decisionsApiFlavor,
): ProviderAdapter {
  const runtime = withModelPaths(resolveProviderRuntime(provider), paths)

  switch (runtime.adapter) {
    case 'openai':
      return {
        ...flavoredAdapter(runtime, flavor, maxOutputTokens ?? null),
        ...createDecisionsOperation(runtime, decisionsApiFlavor),
      }
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return {
        ...flavoredAdapter(runtime, flavor, maxOutputTokens ?? null),
        ...createDecisionsOperation(runtime, decisionsApiFlavor),
      }
    case 'gemini':
      // Gemini speaks none of the OpenAI protocols natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way,
      // and gets `respond`/`respondStream` from the same wrapper any
      // chat-only adapter does. `transcribe` and `embed` are both real and
      // translated (transcriptions §3.6, embeddings §3.4) —
      // createGeminiAdapter supplies them directly, so neither
      // `withTranscribeUnsupported` nor `withEmbedUnsupported` belongs here.
      return withDecideUnsupported(
        withRespondViaChat(createGeminiAdapter(runtime), runtime.name),
        runtime.name,
        'the Gemini API has no Decisions endpoint',
      )
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
    && !paths?.audioTranscriptionsPath && !paths?.embeddingsPath && !paths?.decisionsPath
  ) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  if (paths.messagesPath) config.messagesPath = paths.messagesPath
  if (paths.audioTranscriptionsPath) config.audioTranscriptionsPath = paths.audioTranscriptionsPath
  if (paths.embeddingsPath) config.embeddingsPath = paths.embeddingsPath
  if (paths.decisionsPath) config.decisionsPath = paths.decisionsPath
  return { ...runtime, config }
}

/**
 * Dispatches on the model's resolved chat protocol. Decisions is composed
 * independently by createAdapter.
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
    const chatAdapter = withEmbedUnsupported(
      withTranscribeUnsupported(
        withRespondViaChat(createAnthropicAdapter(runtime, maxOutputTokens), runtime.name),
        runtime.name,
        'the Anthropic Messages API has no transcription endpoint and no audio input at all',
      ),
      runtime.name,
      'the Anthropic Messages API has no embeddings endpoint',
    )
    return withDecideUnsupported(chatAdapter, runtime.name, 'this chat adapter does not provide a Decisions transport')
  }
  return withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
