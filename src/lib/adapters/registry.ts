import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createOpenAIAdapter } from './openai'
import type { ApiFlavor, ProviderAdapter, ProviderConfig, ProviderRuntime } from './types'

/**
 * The single place flavor is decided. It reads one column today, but every
 * caller goes through it so that a per-model layer — which the catalog could
 * supply — lands here rather than in each call site.
 */
export function resolveApiFlavor(provider: ProviderRow): ApiFlavor {
  return provider.apiFlavor
}

export function resolveProviderRuntime(provider: ProviderRow): ProviderRuntime {
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    credentials: decryptJson<Record<string, unknown>>(provider.credentials),
    config: JSON.parse(provider.config) as ProviderConfig,
    apiFlavor: resolveApiFlavor(provider),
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
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}
