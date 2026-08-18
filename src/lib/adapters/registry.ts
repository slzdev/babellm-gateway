import type { ApiFlavor } from '@/lib/api-flavors'
import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createGeminiAdapter } from './gemini'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './openai/responses'
import type { ProviderAdapter, ProviderConfig, ProviderRuntime } from './types'
import { withRespondViaChat } from './wrappers'

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
): ProviderAdapter {
  const runtime = resolveProviderRuntime(provider)

  switch (runtime.adapter) {
    case 'openai':
      return openAIShaped(runtime, flavor)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return openAIShaped(runtime, flavor)
    case 'gemini':
      // Gemini speaks neither OpenAI dialect natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way,
      // and gets `respond`/`respondStream` from the same wrapper any
      // chat-only adapter does.
      return withRespondViaChat(createGeminiAdapter(runtime), runtime.name)
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}

function openAIShaped(runtime: ProviderRuntime, flavor: ApiFlavor): ProviderAdapter {
  // The Responses adapter already implements chat/chatStream through
  // chat-to-responses.ts, so this branch needs no wrapping — it is returned
  // as-is, unlike the chat-only branch below.
  return flavor === 'responses'
    ? createResponsesAdapter(runtime)
    : withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
