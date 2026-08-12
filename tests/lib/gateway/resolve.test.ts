import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { resolveVirtualModel } from '@/lib/gateway/resolve'
import { encryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

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
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 10 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 1 },
  ])

  const { candidates } = await resolveVirtualModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1', 'slow-1'])
  expect(candidates[0].provider.name).toBe('fast-provider')
})

test('excludes disabled targets and targets on disabled providers', async () => {
  const { fast, slow, model } = await seed()
  await db.update(providers).set({ enabled: false }).where(eq(providers.id, slow.id))
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 1 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'disabled-1', priority: 2, enabled: false },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 3 },
  ])

  const { candidates } = await resolveVirtualModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1'])
})

test('throws 404 for an unknown model name', async () => {
  await expect(resolveVirtualModel('nope')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 404 for a disabled virtual model', async () => {
  await db.insert(virtualModels).values({ name: 'off', enabled: false })
  await expect(resolveVirtualModel('off')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 503 when a model exists but has no usable targets', async () => {
  await seed()
  await expect(resolveVirtualModel('house-model')).rejects.toMatchObject({
    status: 503, code: 'no_targets_available',
  })
})
