import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { resolveModel } from '@/lib/gateway/resolve'
import { encryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'
import { seedTargets } from '../../helpers/gateway'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
})

async function seed() {
  const [fast] = await db.insert(providers).values({
    name: 'fast-provider', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [slow] = await db.insert(providers).values({
    name: 'slow-provider', adapter: 'openai', credentials: encryptJson({ apiKey: 'b' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'house-model' }).returning()
  return { fast, slow, model }
}

test('returns candidates ordered by priority', async () => {
  const { fast, slow, model } = await seed()
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 10, weight: 50 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 1, weight: 200 },
  ])

  const { candidates } = await resolveModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1', 'slow-1'])
  expect(candidates[0].provider.name).toBe('fast-provider')
  // priority and weight must survive the mapping — weighted selection
  // (Phase 2) is built on this shape carrying weight through.
  expect(candidates.map((c) => c.priority)).toEqual([1, 10])
  expect(candidates.map((c) => c.weight)).toEqual([200, 50])
})

test('orders equal-priority targets deterministically', async () => {
  const { fast, slow, model } = await seed()

  // A single multi-row insert: both rows share one transaction timestamp,
  // and both take the default priority — so only the id tiebreaker can order them.
  const inserted = await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'a-1' },
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'b-1' },
  ]).returning()

  const first = await resolveModel('house-model')
  const second = await resolveModel('house-model')

  expect(first.candidates.map((c) => c.targetId)).toEqual(
    second.candidates.map((c) => c.targetId),
  )
  expect(first.candidates).toHaveLength(2)

  const expectedOrder = [...inserted].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => t.id)
  expect(first.candidates.map((c) => c.targetId)).toEqual(expectedOrder)
})

test('excludes disabled targets and targets on disabled providers', async () => {
  const { fast, slow, model } = await seed()
  await db.update(providers).set({ enabled: false }).where(eq(providers.id, slow.id))
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 1 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'disabled-1', priority: 2, enabled: false },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 3 },
  ])

  const { candidates } = await resolveModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1'])
})

test('throws 404 for an unknown model name', async () => {
  await expect(resolveModel('nope')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 404 for a disabled virtual model', async () => {
  await db.insert(virtualModels).values({ name: 'off', enabled: false })
  await expect(resolveModel('off')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 503 when a model exists but has no usable targets', async () => {
  await seed()
  await expect(resolveModel('house-model')).rejects.toMatchObject({
    status: 503, code: 'no_targets_available',
  })
})

test('routes `provider/model` straight to that provider’s catalog model', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'grok-4.5' })

  const { candidates } = await resolveModel('fast-provider/grok-4.5')

  expect(candidates).toHaveLength(1)
  expect(candidates[0].provider.id).toBe(fast.id)
  expect(candidates[0].upstreamModel).toBe('grok-4.5')
})

test('gives a direct address a single-attempt failover chain', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'grok-4.5' })

  const { model } = await resolveModel('fast-provider/grok-4.5')

  // There is only ever one candidate, so the policy must not be one that
  // reads a round-robin cursor or rolls dice against an empty pool.
  expect(model.policy).toBe('failover')
  expect(model.maxAttempts).toBe(1)
})

test('splits on the first slash so slashes inside a model id survive', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({
    providerId: fast.id, modelId: 'meta-llama/Llama-3-70b',
  })

  const { candidates } = await resolveModel('fast-provider/meta-llama/Llama-3-70b')

  expect(candidates[0].upstreamModel).toBe('meta-llama/Llama-3-70b')
})

test('prefers a virtual model over a direct address of the same name', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'grok-4.5' })
  const [shadow] = await db.insert(virtualModels)
    .values({ name: 'fast-provider/grok-4.5' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: shadow.id, providerId: fast.id, upstreamModel: 'shadowed-1',
  })

  const { candidates } = await resolveModel('fast-provider/grok-4.5')

  expect(candidates.map((c) => c.upstreamModel)).toEqual(['shadowed-1'])
})

test('routes a direct address whose catalog row is marked missing', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({
    providerId: fast.id, modelId: 'grok-4.5', status: 'missing',
  })

  // A bad sync day marks rows missing rather than deleting them; that must
  // not take a real model off the air.
  const { candidates } = await resolveModel('fast-provider/grok-4.5')
  expect(candidates[0].upstreamModel).toBe('grok-4.5')
})

test('throws 404 when the provider prefix is unknown', async () => {
  await seed()
  await expect(resolveModel('nope-provider/grok-4.5')).rejects.toMatchObject({
    status: 404, code: 'model_not_found', param: 'model',
  })
})

test('throws 404 when the provider does not serve that model', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'grok-4.5' })

  await expect(resolveModel('fast-provider/grok-9')).rejects.toMatchObject({
    status: 404, code: 'model_not_found', param: 'model',
  })
})

test('does not match a catalog model on another provider', async () => {
  const { fast, slow } = await seed()
  await db.insert(catalogModels).values({ providerId: slow.id, modelId: 'grok-4.5' })

  await expect(resolveModel('fast-provider/grok-4.5')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
  expect(fast.id).not.toBe(slow.id)
})

test('throws 503 when the addressed provider is disabled', async () => {
  const { slow } = await seed()
  await db.insert(catalogModels).values({ providerId: slow.id, modelId: 'grok-4.5' })
  await db.update(providers).set({ enabled: false }).where(eq(providers.id, slow.id))

  await expect(resolveModel('slow-provider/grok-4.5')).rejects.toMatchObject({
    status: 503, code: 'no_targets_available',
  })
})

test('carries each target\'s service tier onto its candidate', async () => {
  const { fast, slow, model } = await seed()
  await db.insert(routeTargets).values([
    {
      virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1',
      priority: 1, serviceTier: 'priority',
    },
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 2 },
  ])

  const { candidates } = await resolveModel('house-model')
  // The second target sets no tier, and must stay null rather than inherit the
  // first one's — every candidate carries its own routing instruction.
  expect(candidates.map((c) => c.serviceTier)).toEqual(['priority', null])
})

test('a direct address has no service tier to apply', async () => {
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'grok-4.5' })

  const { candidates } = await resolveModel('fast-provider/grok-4.5')
  // There is no route_targets row behind a direct address, so there is nothing
  // that could have configured a tier.
  expect(candidates[0].serviceTier).toBeNull()
})

test('virtual model targets are breakable and carry their overrides', async () => {
  const { fast, model } = await seed()
  await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: fast.id,
    upstreamModel: 'fast-1',
    breakerThreshold: 2,
    // Left null on purpose: overrides apply per field, so this target pins a
    // threshold and still inherits the global cooldown.
    breakerCooldownSeconds: null,
  })

  const { candidates } = await resolveModel('house-model')

  expect(candidates[0].breakable).toBe(true)
  expect(candidates[0].breakerThreshold).toBe(2)
  expect(candidates[0].breakerCooldownSeconds).toBeNull()
})

test('a direct provider/model address is never breakable', async () => {
  // It is a single-candidate chain, so an open breaker could only turn a
  // request that might have succeeded into a guaranteed 503.
  const { fast } = await seed()
  await db.insert(catalogModels).values({ providerId: fast.id, modelId: 'gpt-5' })

  const { candidates } = await resolveModel('fast-provider/gpt-5')

  expect(candidates).toHaveLength(1)
  expect(candidates[0].breakable).toBe(false)
  expect(candidates[0].breakerThreshold).toBeNull()
  expect(candidates[0].breakerCooldownSeconds).toBeNull()
})

test('a catalogued target with no flavor of its own inherits the provider', async () => {
  // The catalog row exists (unlike the "outside the catalog" test below) but
  // leaves api_flavor NULL, so this pins the NULL-on-a-real-row arm rather
  // than the no-row-at-all one.
  const { model, targets } = await seedTargets({
    targets: [{ name: 'p1' }],
  })
  await db.insert(catalogModels).values({
    providerId: targets[0].provider.id, modelId: 'p1-model',
  })
  await db.update(providers).set({ apiFlavor: 'responses' })
    .where(eq(providers.id, targets[0].provider.id))

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a model flavor overrides the provider for a route target', async () => {
  // The provider still says chat_completions; the model it points at wins.
  const { model } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }],
  })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a target naming a model outside the catalog inherits the provider', async () => {
  // upstream_model is free text, so this is a real arrangement, not a broken
  // one — and it must keep routing rather than drop out of the chain.
  const { model, targets } = await seedTargets({ targets: [{ name: 'p1' }] })
  await db.update(providers).set({ apiFlavor: 'responses' })
    .where(eq(providers.id, targets[0].provider.id))

  const { candidates } = await resolveModel(model.name)

  expect(candidates).toHaveLength(1)
  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a direct provider/model address takes the model flavor', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'openai', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-5', apiFlavor: 'responses',
  })

  const { candidates } = await resolveModel('openai/gpt-5')

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a direct address on a model with no flavor inherits the provider', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'openai', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
    apiFlavor: 'responses',
  }).returning()
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-5' })

  const { candidates } = await resolveModel('openai/gpt-5')

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('one provider can serve a chat model and a responses model', async () => {
  const [model] = await db.insert(virtualModels).values({ name: 'house-model' }).returning()
  const [provider] = await db.insert(providers).values({
    name: 'p1', adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-p1' }),
  }).returning()

  await db.insert(catalogModels).values([
    { providerId: provider.id, modelId: 'cc-model' },
    { providerId: provider.id, modelId: 'resp-model', apiFlavor: 'responses' },
  ])
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: provider.id, upstreamModel: 'cc-model', priority: 0 },
    { virtualModelId: model.id, providerId: provider.id, upstreamModel: 'resp-model', priority: 1 },
  ])

  const { candidates } = await resolveModel('house-model')

  expect(candidates.map((c) => c.apiFlavor)).toEqual(['chat_completions', 'responses'])
})

test('a candidate carries the model path overrides', async () => {
  const { model } = await seedTargets({
    targets: [{ name: 'p1', responsesPath: '/api/v2/responses' }],
  })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].pathOverrides).toEqual({
    chatCompletionsPath: null,
    responsesPath: '/api/v2/responses',
  })
})

test('a target outside the catalog carries no path overrides', async () => {
  const { model } = await seedTargets({ targets: [{ name: 'p1' }] })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].pathOverrides).toBeNull()
})
