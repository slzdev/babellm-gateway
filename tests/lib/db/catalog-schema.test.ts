import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, registryCache, settings } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

async function makeProvider(name = 'openai-prod') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()
  return row
}

test('a catalog row defaults to discovered and available', async () => {
  const provider = await makeProvider()
  const [row] = await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
  }).returning()

  expect(row.origin).toBe('discovered')
  expect(row.status).toBe('available')
  expect(row.kind).toBe('unknown')
  expect(row.canonicalKey).toBeNull()
  expect(row.override).toEqual({})
  expect(row.sources).toEqual({})
})

test('a model id is unique per provider but not across providers', async () => {
  const a = await makeProvider('a')
  const b = await makeProvider('b')

  await db.insert(catalogModels).values({ providerId: a.id, modelId: 'gpt-4o' })
  await db.insert(catalogModels).values({ providerId: b.id, modelId: 'gpt-4o' })

  await expect(
    db.insert(catalogModels).values({ providerId: a.id, modelId: 'gpt-4o' }),
  ).rejects.toThrow()
})

test('deleting a provider cascades to its catalog rows', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-4o' })

  await db.delete(providers).where(eq(providers.id, provider.id))
  expect(await db.select().from(catalogModels)).toHaveLength(0)
})

test('layer blobs and effective columns round-trip', async () => {
  const provider = await makeProvider()
  const [row] = await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId: 'gpt-4o',
    canonicalKey: 'openai/gpt-4o',
    registry: { contextWindow: 128000, inputPerMtok: 2.5 },
    override: { contextWindow: 64000 },
    kind: 'chat',
    contextWindow: 64000,
    inputPerMtok: '2.5',
    modalities: { input: ['text', 'image'], output: ['text'] },
    sources: { contextWindow: 'override', inputPerMtok: 'registry' },
  }).returning()

  expect(row.registry).toEqual({ contextWindow: 128000, inputPerMtok: 2.5 })
  expect(row.contextWindow).toBe(64000)
  expect(row.inputPerMtok).toBe('2.500000')
  expect(row.modalities).toEqual({ input: ['text', 'image'], output: ['text'] })
  expect(row.sources).toEqual({ contextWindow: 'override', inputPerMtok: 'registry' })
})

test('providers carry sync bookkeeping that starts empty', async () => {
  const provider = await makeProvider()
  expect(provider.lastSyncedAt).toBeNull()
  expect(provider.lastSyncStatus).toBeNull()
  expect(provider.lastSyncError).toBeNull()
  expect(provider.lastSyncSummary).toBeNull()

  const [updated] = await db.update(providers).set({
    lastSyncedAt: new Date(),
    lastSyncStatus: 'ok',
    lastSyncSummary: { added: 3, updated: 12, missing: 1, total: 142 },
  }).where(eq(providers.id, provider.id)).returning()

  expect(updated.lastSyncStatus).toBe('ok')
  expect(updated.lastSyncSummary).toEqual({ added: 3, updated: 12, missing: 1, total: 142 })
})

test('registry cache and settings are keyed key-value stores', async () => {
  await db.insert(registryCache).values({
    url: 'https://models.dev/api.json', payload: { 'openai/gpt-4o': { contextWindow: 128000 } },
  })
  const [cache] = await db.select().from(registryCache)
  expect(cache.payload).toEqual({ 'openai/gpt-4o': { contextWindow: 128000 } })
  expect(cache.fetchedAt).toBeInstanceOf(Date)

  await db.insert(settings).values({ key: 'catalog.registry_enabled', value: true })
  const [setting] = await db.select().from(settings)
  expect(setting.value).toBe(true)
})
