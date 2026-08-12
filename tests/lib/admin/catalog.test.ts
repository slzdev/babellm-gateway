import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import type { DiscoveredModel, ProviderAdapter } from '@/lib/adapters/types'
import { syncProvider } from '@/lib/catalog/sync'
import type { RegistryLoad } from '@/lib/catalog/registry'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, listCatalog,
  listPickerModels, setOverride, targetWarnings,
} from '@/lib/admin/catalog'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

const registry: RegistryLoad = {
  index: {
    'openai/gpt-4o': {
      kind: 'chat', contextWindow: 128000, maxOutputTokens: 16384,
      inputPerMtok: 2.5, outputPerMtok: 10, cachedInputPerMtok: 1.25,
      supportsTools: true, supportsStreaming: null, modalities: null,
    },
  },
  status: 'cached', url: 'https://models.dev/api.json',
  fetchedAt: new Date('2026-08-12T00:00:00Z'), error: null,
}

async function makeProvider(name = 'openai-prod') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()
  return row
}

function listing(ids: string[]): ProviderAdapter {
  return {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue(
      ids.map((id): DiscoveredModel => ({ id, fields: {}, raw: { id } })),
    ),
  } as unknown as ProviderAdapter
}

async function seedCatalog(ids: string[], name = 'openai-prod') {
  const provider = await makeProvider(name)
  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(ids) })
  return provider
}

test('lists every model with its provider name and numeric prices', async () => {
  await seedCatalog(['gpt-4o', 'whisper-1'])
  const items = await listCatalog()

  expect(items.map((i) => i.modelId)).toEqual(['gpt-4o', 'whisper-1'])
  expect(items[0].providerName).toBe('openai-prod')
  // Prices come back as numbers, not the '2.500000' pg returns.
  expect(items[0].inputPerMtok).toBe(2.5)
  expect(items[1].inputPerMtok).toBeNull()
})

test('filters by provider, kind, status and search', async () => {
  const a = await seedCatalog(['gpt-4o', 'whisper-1'], 'a')
  await seedCatalog(['gpt-4o'], 'b')

  expect(await listCatalog({ providerId: a.id })).toHaveLength(2)
  expect((await listCatalog({ kind: 'audio' })).map((i) => i.modelId)).toEqual(['whisper-1'])
  expect((await listCatalog({ search: 'GPT' })).map((i) => i.providerName)).toEqual(['a', 'b'])
  expect(await listCatalog({ status: 'missing' })).toHaveLength(0)
})

test('reports how many route targets still point at a model', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  const [item] = await listCatalog()
  expect(item.routeTargetCount).toBe(1)
})

test('an override is merged in and re-computes the effective columns', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await setOverride(before.id, { contextWindow: 64000 })

  const [after] = await listCatalog()
  expect(after.contextWindow).toBe(64000)
  expect(after.sources.contextWindow).toBe('override')
  // Untouched fields keep inheriting.
  expect(after.inputPerMtok).toBe(2.5)
  expect(after.sources.inputPerMtok).toBe('registry')
})

test('overrides accumulate rather than replacing each other', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()

  await setOverride(row.id, { contextWindow: 64000 })
  await setOverride(row.id, { supportsTools: false })

  const [after] = await listCatalog()
  expect(after.override).toEqual({ contextWindow: 64000, supportsTools: false })
  expect(after.contextWindow).toBe(64000)
  expect(after.supportsTools).toBe(false)
})

test('clearing an override removes the key and falls back to the layer below', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()
  await setOverride(row.id, { contextWindow: 64000, supportsTools: false })

  await clearOverrideField(row.id, 'contextWindow')

  const [after] = await listCatalog()
  expect(after.override).toEqual({ supportsTools: false })
  expect(after.contextWindow).toBe(128000)
  expect(after.sources.contextWindow).toBe('registry')
})

test('a manual model can be added for a provider that cannot be discovered', async () => {
  const provider = await makeProvider()
  await addManualModel({ providerId: provider.id, modelId: 'internal-llm', fields: { contextWindow: 32000 } })

  const [item] = await listCatalog()
  expect(item.origin).toBe('manual')
  expect(item.contextWindow).toBe(32000)
  expect(item.sources.contextWindow).toBe('override')
})

test('a manual model still picks up registry metadata when it matches', async () => {
  const provider = await makeProvider()
  await addManualModel({ providerId: provider.id, modelId: 'gpt-4o' }, { registry })

  const [item] = await listCatalog()
  expect(item.canonicalKey).toBe('openai/gpt-4o')
  expect(item.inputPerMtok).toBe(2.5)
})

test('adding a model that already exists is refused with a clear message', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  await expect(
    addManualModel({ providerId: provider.id, modelId: 'gpt-4o' }),
  ).rejects.toThrow(/already in the catalog/i)
})

test('a blank model id is refused', async () => {
  const provider = await makeProvider()
  await expect(
    addManualModel({ providerId: provider.id, modelId: '   ' }),
  ).rejects.toThrow(/model id is required/i)
})

test('deleting removes the row', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()
  await deleteCatalogModel(row.id)
  expect(await listCatalog()).toHaveLength(0)
})

test('the picker groups a provider models chat-first with unknown last', async () => {
  const provider = await seedCatalog(['whisper-1', 'gpt-4o', 'ft:gpt-4o:acme:x2'])
  const groups = await listPickerModels(provider.id)

  expect(groups.map((g) => g.value)).toEqual(['chat', 'audio', 'unknown'])
  expect(groups[0].items.map((i) => i.modelId)).toEqual(['gpt-4o'])
  expect(groups.at(-1)!.items.map((i) => i.modelId)).toEqual(['ft:gpt-4o:acme:x2'])
})

test('the picker carries the context and price it will display', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [chat] = await listPickerModels(provider.id)

  expect(chat.items[0]).toMatchObject({
    modelId: 'gpt-4o', contextWindow: 128000, inputPerMtok: 2.5, outputPerMtok: 10,
    status: 'available',
  })
})

test('a target on a never-synced provider is not called a typo', async () => {
  // On first deploy every target would otherwise look wrong.
  const provider = await makeProvider()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  }).returning()

  expect(await targetWarnings()).toEqual({ [target.id]: 'never_synced' })
})

test('a target naming a model the catalog does not have is flagged', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [typo] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mimi',
  }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  expect(await targetWarnings()).toEqual({ [typo.id]: 'not_in_catalog' })
})

test('a target pointing at a retired model is flagged as missing', async () => {
  const provider = await seedCatalog(['gpt-4o', 'gpt-4.5-preview'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4.5-preview',
  }).returning()

  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(['gpt-4o']) })

  expect(await targetWarnings()).toEqual({ [target.id]: 'missing' })
})
