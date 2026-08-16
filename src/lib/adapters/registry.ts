import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createGeminiAdapter } from './gemini'
import { createOpenAIAdapter } from './openai'
import type { ProviderAdapter, ProviderConfig, ProviderRuntime } from './types'

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

export function createAdapter(provider: ProviderRow): ProviderAdapter {
  const runtime = resolveProviderRuntime(provider)

  switch (runtime.adapter) {
    case 'openai':
      return createOpenAIAdapter(runtime)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return createOpenAIAdapter(runtime)
    case 'gemini':
      return createGeminiAdapter(runtime)
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}
