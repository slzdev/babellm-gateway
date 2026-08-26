import { db } from '@/lib/db'
import { apiKeys, catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { generateApiKey } from '@/lib/gateway/auth'
import type { ServiceTier } from '@/lib/admin/models'
import type { ApiFlavor } from '@/lib/api-flavors'
import type { ProviderAdapter } from '@/lib/adapters/types'

export interface SeedOptions {
  virtualModel?: string
  upstreamModel?: string
  serviceTier?: ServiceTier | null
  adapter?: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
  credentials?: Record<string, unknown>
  /** Limits on the seeded API key. Absent means an unlimited key, which is
   * what every pre-existing test expects. */
  limits?: {
    rpmLimit?: number | null
    tpmLimit?: number | null
    budgetMonthlyUsd?: string | null
    budgetTotalUsd?: string | null
  }
}

export async function seedGateway(options: SeedOptions = {}) {
  const virtualModel = options.virtualModel ?? 'house-model'
  const upstreamModel = options.upstreamModel ?? 'gpt-4o-mini'

  const [provider] = await db.insert(providers).values({
    name: 'test-provider',
    adapter: options.adapter ?? 'openai',
    credentials: encryptJson(options.credentials ?? { apiKey: 'sk-upstream' }),
  }).returning()

  const [model] = await db.insert(virtualModels).values({ name: virtualModel }).returning()

  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel,
    serviceTier: options.serviceTier ?? null,
  }).returning()

  const generated = generateApiKey()
  const [key] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    ...options.limits,
  }).returning()

  return { provider, model, target, key, apiKey: generated.key, virtualModel, upstreamModel }
}

/**
 * Gives a provider's model catalog prices.
 *
 * An upsert rather than an insert because seedTargets already writes a
 * catalog_models row whenever a target declares an apiFlavor, and
 * catalog_models_provider_model_idx makes a second insert a constraint
 * violation. Callers should not have to know which seeder they used.
 */
export async function seedPrices(
  providerId: string,
  modelId: string,
  prices: {
    inputPerMtok?: string
    cachedInputPerMtok?: string
    outputPerMtok?: string
  },
) {
  await db
    .insert(catalogModels)
    .values({ providerId, modelId, ...prices })
    .onConflictDoUpdate({
      target: [catalogModels.providerId, catalogModels.modelId],
      set: prices,
    })
}

export function chatRequest(
  body: unknown,
  apiKey: string | null,
  headers: Record<string, string> = {},
) {
  return new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export function responsesRequest(
  body: unknown,
  apiKey: string | null,
  headers: Record<string, string> = {},
) {
  return new Request('http://gateway.test/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
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
      async respond() {
        throw new Error('respond not stubbed')
      },
      async *respondStream() {
        throw new Error('respondStream not stubbed')
      },
      ...adapter,
    }) as ProviderAdapter,
  }
}

export interface TargetSpec {
  /** Provider name, also used to build a distinct upstream model name. */
  name: string
  priority?: number
  weight?: number
  enabled?: boolean
  serviceTier?: ServiceTier | null
  /** Written onto the target's catalog_models row, not the provider or the
   *  target: the model is what owns the flavor. */
  apiFlavor?: ApiFlavor | null
  chatCompletionsPath?: string | null
  responsesPath?: string | null
  messagesPath?: string | null
  audioTranscriptionsPath?: string | null
  adapter?: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
}

export interface SeedTargetsOptions {
  virtualModel?: string
  policy?: 'failover' | 'weighted' | 'round_robin'
  maxAttempts?: number
  targets: TargetSpec[]
  /** Limits on the seeded API key. Absent means an unlimited key, which is
   * what every pre-existing test expects. */
  limits?: {
    rpmLimit?: number | null
    tpmLimit?: number | null
    budgetMonthlyUsd?: string | null
    budgetTotalUsd?: string | null
  }
}

/**
 * Seeds one virtual model fronting several providers. seedGateway covers the
 * single-target case every Phase 1 test uses; this is for routing, where the
 * whole point is which of several targets gets picked.
 */
export async function seedTargets(options: SeedTargetsOptions) {
  const [model] = await db.insert(virtualModels).values({
    name: options.virtualModel ?? 'house-model',
    policy: options.policy ?? 'failover',
    maxAttempts: options.maxAttempts ?? 3,
  }).returning()

  const targets = []
  for (const spec of options.targets) {
    const [provider] = await db.insert(providers).values({
      name: spec.name,
      adapter: spec.adapter ?? 'openai',
      credentials: encryptJson({ apiKey: `sk-${spec.name}` }),
    }).returning()

    const [target] = await db.insert(routeTargets).values({
      virtualModelId: model.id,
      providerId: provider.id,
      upstreamModel: `${spec.name}-model`,
      priority: spec.priority ?? 0,
      weight: spec.weight ?? 100,
      serviceTier: spec.serviceTier ?? null,
      enabled: spec.enabled ?? true,
    }).returning()

    if (
      spec.apiFlavor || spec.chatCompletionsPath || spec.responsesPath || spec.messagesPath
      || spec.audioTranscriptionsPath
    ) {
      await db.insert(catalogModels).values({
        providerId: provider.id,
        modelId: `${spec.name}-model`,
        apiFlavor: spec.apiFlavor ?? null,
        chatCompletionsPath: spec.chatCompletionsPath ?? null,
        responsesPath: spec.responsesPath ?? null,
        messagesPath: spec.messagesPath ?? null,
        audioTranscriptionsPath: spec.audioTranscriptionsPath ?? null,
      })
    }

    targets.push({ provider, target })
  }

  const generated = generateApiKey()
  const [key] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    ...options.limits,
  }).returning()

  return { model, targets, key, apiKey: generated.key }
}

/**
 * A deps object whose adapter depends on which provider is being called, so a
 * test can make one target fail and another succeed.
 */
export function fakeAdapterByProvider(
  byName: Record<string, Partial<ProviderAdapter>>,
) {
  return {
    createAdapter: (provider: { name: string }) => ({
      async chat() {
        throw new Error(`chat not stubbed for ${provider.name}`)
      },
      async *chatStream() {
        throw new Error(`chatStream not stubbed for ${provider.name}`)
      },
      async respond() {
        throw new Error(`respond not stubbed for ${provider.name}`)
      },
      async *respondStream() {
        throw new Error(`respondStream not stubbed for ${provider.name}`)
      },
      ...(byName[provider.name] ?? {}),
    }) as ProviderAdapter,
  }
}
