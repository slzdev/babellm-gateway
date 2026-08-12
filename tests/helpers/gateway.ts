import { db } from '@/lib/db'
import { apiKeys, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { generateApiKey } from '@/lib/gateway/auth'
import type { ProviderAdapter } from '@/lib/adapters/types'

export interface SeedOptions {
  virtualModel?: string
  upstreamModel?: string
}

export async function seedGateway(options: SeedOptions = {}) {
  const virtualModel = options.virtualModel ?? 'house-model'
  const upstreamModel = options.upstreamModel ?? 'gpt-4o-mini'

  const [provider] = await db.insert(providers).values({
    name: 'test-provider',
    adapter: 'openai',
    credentials: encryptJson({ apiKey: 'sk-upstream' }),
  }).returning()

  const [model] = await db.insert(virtualModels).values({ name: virtualModel }).returning()

  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel,
  }).returning()

  const generated = generateApiKey()
  const [key] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
  }).returning()

  return { provider, model, target, key, apiKey: generated.key, virtualModel, upstreamModel }
}

export function chatRequest(body: unknown, apiKey: string | null) {
  return new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

export function fakeAdapterDeps(adapter: Partial<ProviderAdapter>) {
  return {
    createAdapter: () => ({
      async chat() {
        throw new Error('chat not stubbed')
      },
      async *chatStream() {
        throw new Error('chatStream not stubbed')
      },
      ...adapter,
    }) as ProviderAdapter,
  }
}
