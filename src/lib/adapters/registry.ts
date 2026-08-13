import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './openai/responses'
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

/**
 * Chat Completions and Responses providers share every branch above this
 * point — credentials, base URL, adapter kind — and differ only in which
 * client method the adapter calls. Keeping that choice in one helper is what
 * lets the two cases above read identically otherwise.
 */
function adapterFor(runtime: ProviderRuntime, provider: ProviderRow): ProviderAdapter {
  return resolveApiFlavor(provider) === 'responses'
    ? createResponsesAdapter(runtime)
    : createOpenAIAdapter(runtime)
}

export function createAdapter(provider: ProviderRow): ProviderAdapter {
  const runtime = resolveProviderRuntime(provider)

  switch (runtime.adapter) {
    case 'openai':
      return adapterFor(runtime, provider)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return adapterFor(runtime, provider)
    case 'gemini':
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}
