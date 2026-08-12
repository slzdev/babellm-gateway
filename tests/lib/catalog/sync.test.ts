import { beforeEach, expect, test, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai'
import type { PoolClient } from 'pg'
import { db, pool } from '@/lib/db'
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

test('a discovery timeout is named as one, whatever shape the adapter throws', () => {
  // The real SDK classes on purpose: the whole hazard is that they leave `name`
  // as the inherited 'Error', so only the constructor identifies them. A
  // hand-rolled fake would not reproduce that.
  expect(describeDiscoveryError(new APIUserAbortError({})))
    .toMatch(/timed out after 30s/i)
  expect(describeDiscoveryError(new APIConnectionTimeoutError({})))
    .toMatch(/timed out connecting/i)
  // What a non-SDK adapter passing the raw signal to fetch would surface.
  expect(describeDiscoveryError(new DOMException('aborted due to timeout', 'TimeoutError')))
    .toMatch(/timed out after 30s/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { name: 'AbortError' })))
    .toMatch(/timed out after 30s/i)
  // A plain connection failure is not a timeout and keeps its own message.
  expect(describeDiscoveryError(new APIConnectionError({ message: 'Connection error.' })))
    .toMatch(/connection error/i)
})

test('a timed-out discovery records the timeout on the provider row', async () => {
  const provider = await makeProvider()
  const timingOut = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockRejectedValue(new APIUserAbortError({})),
  } as unknown as ProviderAdapter

  const result = await syncProvider(provider.id, opts(timingOut))

  expect(result.status).toBe('failed')
  expect(result.error).toMatch(/timed out after 30s/i)
  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id))
  expect(row.lastSyncError).toMatch(/timed out after 30s/i)
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

test('a nonexistent provider id throws rather than returning a result', async () => {
  await expect(
    syncProvider('00000000-0000-0000-0000-000000000000', opts(adapterListing([]))),
  ).rejects.toThrow(/not found/i)
})

/**
 * Advisory locks are held per session and are re-entrant within one. Asserting
 * that a later sync re-acquires the lock therefore proves nothing: a release
 * issued on the wrong pooled connection returns false and leaves the lock held,
 * yet the next sync pops that same connection off the pool's LIFO idle stack and
 * re-locks it happily. Only the absence of the lock in pg_locks is real evidence.
 */
async function advisoryLockCount() {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  )
  return rows[0].n
}

test('a concurrent sync is refused, and the lock is truly released afterwards', async () => {
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

  // Proves the probe below actually observes this lock, so its later reading of
  // zero means "released" rather than "querying the wrong thing".
  expect(await advisoryLockCount()).toBe(1)

  const fast = adapterListing(['gpt-4o'])
  const second = await syncProvider(provider.id, opts(fast))

  expect(second.status).toBe('failed')
  expect(second.error).toMatch(/already running/i)
  expect(fast.listModels).not.toHaveBeenCalled()

  release()
  expect((await first).status).toBe('ok')

  // The load-bearing assertion: the lock is gone from the server, not merely
  // re-acquirable by whichever session happens to already hold it.
  expect(await advisoryLockCount()).toBe(0)

  expect((await syncProvider(provider.id, opts(fast))).status).toBe('ok')
  expect(await advisoryLockCount()).toBe(0)
})

test('an unlock failure neither discards the result nor leaks the lock', async () => {
  const provider = await makeProvider()
  const connect = pool.connect.bind(pool) as (cb?: unknown) => Promise<PoolClient> | void
  // pool.query() takes a connection through the CALLBACK form internally, so
  // that form has to pass straight through or every drizzle query in this test
  // would hang. Only syncProvider's own promise-form checkout is wrapped.
  const spy = vi.spyOn(pool, 'connect').mockImplementation(((cb?: unknown) => {
    if (typeof cb === 'function') return connect(cb)
    return (connect() as Promise<PoolClient>).then((client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown
      client.query = ((text: unknown, ...rest: unknown[]) => (
        typeof text === 'string' && text.includes('pg_advisory_unlock')
          ? Promise.reject(new Error('connection terminated unexpectedly'))
          : query(text, ...rest)
      )) as typeof client.query
      return client
    })
  }) as typeof pool.connect)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

  try {
    // The sync itself succeeded and its outcome is already on the provider row;
    // a failed unlock must not turn that into a thrown error.
    const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))
    expect(result.status).toBe('ok')
    expect(logged).toHaveBeenCalled()
    expect(await rowsFor(provider.id)).toHaveLength(1)

    // release(err) destroys the client rather than recycling it, and ending the
    // session is what makes Postgres drop the lock this connection still holds.
    await vi.waitFor(async () => expect(await advisoryLockCount()).toBe(0))
  } finally {
    spy.mockRestore()
    logged.mockRestore()
  }

  // The provider is still syncable afterwards.
  expect((await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))).status).toBe('ok')
})
