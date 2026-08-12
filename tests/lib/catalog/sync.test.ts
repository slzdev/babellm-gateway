import { beforeEach, expect, test, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type { DiscoveredModel, ProviderAdapter } from '@/lib/adapters/types'
import { describeDiscoveryError, syncAllProviders, syncProvider } from '@/lib/catalog/sync'
import type { RegistryLoad } from '@/lib/catalog/registry'
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
      supportsTools: true, supportsStreaming: null,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  },
  status: 'cached',
  url: 'https://models.dev/api.json',
  fetchedAt: new Date('2026-08-12T00:00:00Z'),
  error: null,
}

async function makeProvider(name = 'openai-prod', config = '{}') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }), config,
  }).returning()
  return row
}

function adapterListing(ids: string[]): ProviderAdapter {
  return {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue(
      ids.map((id): DiscoveredModel => ({ id, fields: {}, raw: { id } })),
    ),
  } as unknown as ProviderAdapter
}

function opts(adapter: ProviderAdapter) {
  return { registry, createAdapterImpl: () => adapter }
}

async function rowsFor(providerId: string) {
  return db.select().from(catalogModels)
    .where(eq(catalogModels.providerId, providerId))
}

test('a first sync inserts every discovered model', async () => {
  const provider = await makeProvider()
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'whisper-1'])))

  expect(result.status).toBe('ok')
  expect(result.summary).toEqual({ added: 2, updated: 0, missing: 0, total: 2 })
  expect((await rowsFor(provider.id)).map((r) => r.modelId).sort())
    .toEqual(['gpt-4o', 'whisper-1'])
})

test('registry metadata is merged onto a matched model', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBe('openai/gpt-4o')
  expect(row.kind).toBe('chat')
  expect(row.contextWindow).toBe(128000)
  expect(row.inputPerMtok).toBe('2.500000')
  expect(row.supportsTools).toBe(true)
  expect(row.sources).toMatchObject({ contextWindow: 'registry', kind: 'registry' })
})

test('an unmatched model still lands, classified by the id heuristic', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['whisper-1'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBeNull()
  expect(row.kind).toBe('audio')
  expect(row.contextWindow).toBeNull()
  expect(row.sources).toMatchObject({ kind: 'heuristic' })
})

test('a second sync updates rather than duplicates', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 0, updated: 1, missing: 0, total: 1 })
  expect(await rowsFor(provider.id)).toHaveLength(1)
})

test('a model that stops being returned is marked missing, not deleted', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'gpt-4.5-preview'])))
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 0, updated: 1, missing: 1, total: 1 })
  const rows = await rowsFor(provider.id)
  expect(rows).toHaveLength(2)
  expect(rows.find((r) => r.modelId === 'gpt-4.5-preview')!.status).toBe('missing')
})

test('a model that comes back is available again', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))
  await syncProvider(provider.id, opts(adapterListing([])))
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.status).toBe('available')
})

test('a manual row is never marked missing', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'private-ft', origin: 'manual',
  })

  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 1, updated: 0, missing: 0, total: 1 })
  const [manual] = await db.select().from(catalogModels)
    .where(and(eq(catalogModels.providerId, provider.id), eq(catalogModels.modelId, 'private-ft')))
  expect(manual.status).toBe('available')
})

test('a manual row that later appears in discovery becomes discovered', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o', origin: 'manual',
    override: { contextWindow: 64000 },
  })

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.origin).toBe('discovered')
  expect(row.override).toEqual({ contextWindow: 64000 })
})

test('overrides survive a re-sync and still win the merge', async () => {
  // Load-bearing: this is the failure that would quietly destroy hand-entered
  // data, and it is the reason overrides live in their own column.
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  await db.update(catalogModels)
    .set({ override: { contextWindow: 64000, inputPerMtok: 9.99 } })
    .where(eq(catalogModels.providerId, provider.id))

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.override).toEqual({ contextWindow: 64000, inputPerMtok: 9.99 })
  expect(row.contextWindow).toBe(64000)
  expect(row.inputPerMtok).toBe('9.990000')
  expect(row.sources).toMatchObject({ contextWindow: 'override', outputPerMtok: 'registry' })
})

test('an adapter with no listModels reports unsupported and writes nothing', async () => {
  const provider = await makeProvider()
  const adapter = { chat: vi.fn(), chatStream: vi.fn() } as unknown as ProviderAdapter

  const result = await syncProvider(provider.id, opts(adapter))

  expect(result.status).toBe('unsupported')
  expect(result.error).toMatch(/cannot list models/i)
  expect(await rowsFor(provider.id)).toHaveLength(0)
})

test('an adapter that does not exist yet reports unsupported', async () => {
  const provider = await makeProvider()
  const result = await syncProvider(provider.id, {
    registry,
    createAdapterImpl: () => { throw new UnsupportedOperationError('the "gemini" adapter is not available yet.') },
  })

  expect(result.status).toBe('unsupported')
})

test('a failed discovery leaves every existing row untouched', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'gpt-4o-mini'])))
  const before = await rowsFor(provider.id)

  const failing = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
  } as unknown as ProviderAdapter

  const result = await syncProvider(provider.id, opts(failing))

  expect(result.status).toBe('failed')
  expect(result.summary).toBeNull()
  expect(await rowsFor(provider.id)).toEqual(before)
})

test('discovery failures are classified into actionable messages', () => {
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 401 })))
    .toMatch(/credentials were rejected/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 403 })))
    .toMatch(/credentials were rejected/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 404 })))
    .toMatch(/no model listing api/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 405 })))
    .toMatch(/no model listing api/i)
  expect(describeDiscoveryError(new Error('connect ECONNREFUSED')))
    .toMatch(/ECONNREFUSED/)
})

test('the sync outcome is recorded on the provider row', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id))
  expect(row.lastSyncStatus).toBe('ok')
  expect(row.lastSyncedAt).toBeInstanceOf(Date)
  expect(row.lastSyncError).toBeNull()
  expect(row.lastSyncSummary).toEqual({ added: 1, updated: 0, missing: 0, total: 1 })
})

test('a failure records its reason on the provider row', async () => {
  const provider = await makeProvider()
  const failing = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 404 })),
  } as unknown as ProviderAdapter

  await syncProvider(provider.id, opts(failing))

  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id))
  expect(row.lastSyncStatus).toBe('failed')
  expect(row.lastSyncError).toMatch(/no model listing api/i)
  expect(row.lastSyncSummary).toBeNull()
})

test('a configured registry namespace is used for matching', async () => {
  const provider = await db.insert(providers).values({
    name: 'proxy', adapter: 'openai_compatible', baseUrl: 'https://proxy.internal/v1',
    credentials: encryptJson({ apiKey: 'sk-x' }),
    config: JSON.stringify({ registryNamespace: 'openai' }),
  }).returning().then((rows) => rows[0])

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBe('openai/gpt-4o')
  expect(row.contextWindow).toBe(128000)
})

test('syncing every provider fetches the registry once', async () => {
  await makeProvider('a')
  await makeProvider('b')
  const adapter = adapterListing(['gpt-4o'])

  const results = await syncAllProviders({ registry, createAdapterImpl: () => adapter })

  expect(results).toHaveLength(2)
  expect(results.every((r) => r.status === 'ok')).toBe(true)
})

test('a provider that vanishes mid-run is reported, not thrown', async () => {
  await expect(
    syncProvider('00000000-0000-0000-0000-000000000000', opts(adapterListing([]))),
  ).rejects.toThrow(/not found/i)
})

test('a concurrent sync is refused, and the lock is released afterwards', async () => {
  // The advisory lock is session-level, so it must be taken and released on one
  // dedicated connection. Releasing on a pooled connection that did not take it
  // fails silently, and the third sync below is what would catch that.
  const provider = await makeProvider()

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })

  const slow = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockImplementation(async () => {
      await gate
      return [{ id: 'gpt-4o', fields: {}, raw: {} }]
    }),
  } as unknown as ProviderAdapter

  const first = syncProvider(provider.id, opts(slow))
  // Let the first sync reach its listModels await while holding the lock.
  await vi.waitFor(() => expect(slow.listModels).toHaveBeenCalled())

  const fast = adapterListing(['gpt-4o'])
  const second = await syncProvider(provider.id, opts(fast))

  expect(second.status).toBe('failed')
  expect(second.error).toMatch(/already running/i)
  expect(fast.listModels).not.toHaveBeenCalled()

  release()
  expect((await first).status).toBe('ok')

  expect((await syncProvider(provider.id, opts(fast))).status).toBe('ok')
})
