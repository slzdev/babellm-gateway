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
import { withRespondViaChat, withTranscribeUnsupported } from './wrappers'

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
      // chat-only adapter does. `transcribe` is a placeholder until Task 6
      // gives Gemini a real translated implementation (design doc §3.6) —
      // until then this keeps the interface honest rather than throwing a
      // TypeScript error at every other adapter's expense.
      return withTranscribeUnsupported(
        withRespondViaChat(createGeminiAdapter(runtime), runtime.name),
        runtime.name,
        'Gemini transcription support is not implemented yet',
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
    && !paths?.audioTranscriptionsPath
  ) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  if (paths.messagesPath) config.messagesPath = paths.messagesPath
  if (paths.audioTranscriptionsPath) config.audioTranscriptionsPath = paths.audioTranscriptionsPath
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
    // The one true exception (design doc §3.4): Anthropic's own API has no
    // transcription endpoint and no audio input at all, regardless of which
    // adapter reaches it. Unlike the Gemini branch above, this is not a
    // placeholder — the throw is permanent, just unreachable through the
    // gateway once §3.5's routing filter is in place.
    return withTranscribeUnsupported(
      withRespondViaChat(createAnthropicAdapter(runtime, maxOutputTokens), runtime.name),
      runtime.name,
      'the Anthropic Messages API has no transcription endpoint and no audio input at all',
    )
  }
  return withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
