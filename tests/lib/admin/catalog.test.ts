import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  catalogModels, providers, routeTargets, virtualModels,
} from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import type { DiscoveredModel, ProviderAdapter } from '@/lib/adapters/types'
import { syncProvider } from '@/lib/catalog/sync'
import type { RegistryLoad } from '@/lib/catalog/registry'
import type { ApiFlavor } from '@/lib/api-flavors'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, listCatalog,
  listPickerModels, setModelGateway, setOverride, targetGatewayViews, targetWarnings,
} from '@/lib/admin/catalog'
import { addRouteTarget, createVirtualModel } from '@/lib/admin/models'
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

test('routing from a catalog row reuses addRouteTarget', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()

  await addRouteTarget({
    virtualModelId: model.id,
    providerId: item.providerId,
    upstreamModel: item.modelId,
  })

  const targets = await db.select().from(routeTargets)
  expect(targets).toHaveLength(1)
  expect(targets[0].upstreamModel).toBe('gpt-4o')
  expect(targets[0].weight).toBe(100)

  // The catalog now reports the reference, which drives the "still routed" badge.
  const [after] = await listCatalog()
  expect(after.routeTargetCount).toBe(1)
})

test('gateway settings are stored on the model and leave the layers alone', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setOverride(before.id, { contextWindow: 999 })

  await setModelGateway(before.id, {
    apiFlavor: 'responses',
    chatCompletionsPath: '/api/chat',
    responsesPath: '/api/v2/responses',
  })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBe('responses')
  expect(item.chatCompletionsPath).toBe('/api/chat')
  expect(item.responsesPath).toBe('/api/v2/responses')
  // These are not layer fields: the override and the value merged from it
  // must come through untouched.
  expect(item.override.contextWindow).toBe(999)
  expect(item.contextWindow).toBe(999)
})

test('a blank path clears the override back to the provider default', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { responsesPath: '/api/v2/responses' })

  await setModelGateway(before.id, { responsesPath: '' })

  const [item] = await listCatalog()
  expect(item.responsesPath).toBeNull()
})

test('an empty flavor clears back to inheriting the provider', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { apiFlavor: 'responses' })

  await setModelGateway(before.id, { apiFlavor: null })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBeNull()
})

test('an unknown flavor is refused', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()

  await expect(
    setModelGateway(item.id, { apiFlavor: 'grpc' as ApiFlavor }),
  ).rejects.toThrow('"grpc" is not a supported API flavor.')
})

test('a path that is really a URL is refused', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()

  await expect(
    setModelGateway(item.id, { responsesPath: 'https://api.example/v1/responses' }),
  ).rejects.toThrow(/not a valid path/)
})

test('the list carries what a blank field would inherit', async () => {
  const provider = await makeProvider('paths-p')
  await db.update(providers)
    .set({ apiFlavor: 'responses', config: JSON.stringify({ responsesPath: '/p/responses' }) })
    .where(eq(providers.id, provider.id))
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-5' })

  const [item] = await listCatalog({ search: 'gpt-5' })

  expect(item.providerApiFlavor).toBe('responses')
  expect(item.providerPaths.responsesPath).toBe('/p/responses')
  expect(item.providerPaths.chatCompletionsPath).toBe('/chat/completions')
})

test('a target reports the flavor its model pins', async () => {
  const provider = await makeProvider('gw-p')
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'o5-pro', apiFlavor: 'responses',
  })
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'o5-pro',
  })

  const views = await targetGatewayViews()

  expect(views[target.id]).toEqual({ flavor: 'responses', source: 'model' })
})

test('a target whose model pins nothing reports the provider as the source', async () => {
  const provider = await makeProvider('gw-q')
  await db.update(providers).set({ apiFlavor: 'responses' })
    .where(eq(providers.id, provider.id))
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'not-catalogued',
  })

  const views = await targetGatewayViews()

  expect(views[target.id]).toEqual({ flavor: 'responses', source: 'provider' })
})

test('the Anthropic flavor and a messages path are stored on the model', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await setModelGateway(before.id, {
    apiFlavor: 'anthropic_messages',
    messagesPath: 'anthropic/v1/messages/',
  })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBe('anthropic_messages')
  // parseProviderPath normalizes the missing leading slash and the trailing one.
  expect(item.messagesPath).toBe('/anthropic/v1/messages')
})

test('a blank messages path clears back to inheriting the provider', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { messagesPath: '/m' })

  await setModelGateway(before.id, { messagesPath: '' })

  const [item] = await listCatalog()
  expect(item.messagesPath).toBeNull()
})

test('a full URL in the messages path is refused rather than saved', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await expect(setModelGateway(before.id, { messagesPath: 'https://elsewhere.test/v1/messages' }))
    .rejects.toThrow(/not a valid path/)

  const [item] = await listCatalog()
  expect(item.messagesPath).toBeNull()
})

test('the list item reports the provider messages path as the inherited placeholder', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()
  expect(item.providerPaths.messagesPath).toBe('/messages')
})

/** The one catalog row `seedCatalog(['gpt-4o'])` produces. */
async function onlyModel() {
  const [row] = await db.select().from(catalogModels)
  return row
}

test('a model inherits by default, which listCatalog reports as null', async () => {
  await seedCatalog(['gpt-4o'])

  const [item] = await listCatalog()

  expect(item.forceUpstreamStream).toBeNull()
  expect(item.providerForceUpstreamStream).toBe(false)
})

test('listCatalog surfaces the provider default so the dialog can name it', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, provider.id))

  const [item] = await listCatalog()

  // The dialog's "(inherit — forced)" label reads this, so an operator can see
  // what blank means without opening the Providers page.
  expect(item.providerForceUpstreamStream).toBe(true)
  expect(item.forceUpstreamStream).toBeNull()
})

test('setModelGateway stores an explicit true', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})

test('setModelGateway stores an explicit false, which is not the same as inheriting', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: false })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  // Not null: "never force" has to survive a provider that forces.
  expect(row.forceUpstreamStream).toBe(false)
})

test('setModelGateway clears back to inherit on null', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })
  await setModelGateway(model.id, { forceUpstreamStream: null })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBeNull()
})

test('setModelGateway leaves the field alone when the key is absent', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })
  await setModelGateway(model.id, { apiFlavor: 'responses' })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})

test('a re-sync does not reset the setting', async () => {
  // The whole reason it is a column and not a catalog layer: sync() and
  // merge() must never be able to undo an operator's decision.
  const provider = await seedCatalog(['gpt-4o'])
  const model = await onlyModel()
  await setModelGateway(model.id, { forceUpstreamStream: true })

  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(['gpt-4o']) })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})
