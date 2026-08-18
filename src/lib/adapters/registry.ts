import type { ApiFlavor } from '@/lib/api-flavors'
import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createAnthropicAdapter } from './anthropic'
import { createGeminiAdapter } from './gemini'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './openai/responses'
import type {
  ModelPathOverrides, ProviderAdapter, ProviderConfig, ProviderRuntime, TargetSettings,
} from './types'
import { withForcedChatStream, withForcedResponseStream, withRespondViaChat } from './wrappers'

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
  settings: TargetSettings = {},
): ProviderAdapter {
  const flavor = settings.flavor ?? provider.apiFlavor
  const forceStream = settings.forceStream ?? provider.forceUpstreamStream
  const maxOutputTokens = settings.maxOutputTokens ?? null
  const runtime = withModelPaths(resolveProviderRuntime(provider), settings.paths)

  switch (runtime.adapter) {
    case 'openai':
      return flavoredAdapter(runtime, flavor, maxOutputTokens, forceStream)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return flavoredAdapter(runtime, flavor, maxOutputTokens, forceStream)
    case 'gemini': {
      // Gemini speaks neither OpenAI dialect natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way,
      // and gets `respond`/`respondStream` from the same wrapper any
      // chat-only adapter does. Forcing applies all the same — it is about the
      // upstream call, not the dialect.
      const base = createGeminiAdapter(runtime)
      return withRespondViaChat(forceStream ? withForcedChatStream(base) : base, runtime.name)
    }
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
function withModelPaths(
  runtime: ProviderRuntime,
  paths: ModelPathOverrides | null | undefined,
): ProviderRuntime {
  if (!paths?.chatCompletionsPath && !paths?.responsesPath && !paths?.messagesPath) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  if (paths.messagesPath) config.messagesPath = paths.messagesPath
  return { ...runtime, config }
}

/**
 * Dispatches on the flavor the model resolved to, then applies forcing. Two of
 * the three branches need `withRespondViaChat`; the Responses adapter already
 * implements chat/chatStream through chat-to-responses.ts.
 *
 * For a chat-only adapter the forcing wrapper goes INSIDE withRespondViaChat,
 * so `respond` derives from the already-forced `chat` and one wrapper covers
 * both ingresses. Reversing that order would leave the Responses ingress
 * calling a non-streaming upstream on a provider that refuses one.
 */
function flavoredAdapter(
  runtime: ProviderRuntime,
  flavor: ApiFlavor,
  maxOutputTokens: number | null,
  forceStream: boolean,
): ProviderAdapter {
  if (flavor === 'responses') {
    const base = createResponsesAdapter(runtime)
    // Both native pairs wrapped independently: a Responses request must not
    // round-trip through chat shape merely because chat is forced too.
    return forceStream ? withForcedResponseStream(withForcedChatStream(base)) : base
  }

  const base = flavor === 'anthropic_messages'
    ? createAnthropicAdapter(runtime, maxOutputTokens)
    : createOpenAIAdapter(runtime)

  return withRespondViaChat(forceStream ? withForcedChatStream(base) : base, runtime.name)
}
