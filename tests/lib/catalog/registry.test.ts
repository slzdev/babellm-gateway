import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { registryCache } from '@/lib/db/schema'
import { setCatalogSettings } from '@/lib/settings'
import {
  REGISTRY_MAX_AGE_MS, kindFromModelsDev, loadRegistry, projectModelsDev,
} from '@/lib/catalog/registry'
import fixture from '../../fixtures/models-dev.json'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const URL_DEFAULT = 'https://models.dev/api.json'

function okFetch(body: unknown = fixture) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: 'OK', json: async () => body,
  }) as unknown as typeof fetch
}

test('projection keys every model by provider slug', () => {
  const index = projectModelsDev(fixture)
  expect(Object.keys(index).sort()).toEqual([
    'amazon-bedrock/us.deepseek.r1-v1:0',
    'openai/gpt-4o',
    'openai/text-embedding-3-small',
    'poe/google/veo-3',
  ])
})

test('projection maps limits, costs and tool support', () => {
  const entry = projectModelsDev(fixture)['openai/gpt-4o']
  expect(entry).toEqual({
    kind: 'chat',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPerMtok: 2.5,
    outputPerMtok: 10,
    cachedInputPerMtok: 1.25,
    supportsTools: true,
    supportsStreaming: null,
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  })
})

test('a missing cache_read becomes null rather than undefined', () => {
  expect(projectModelsDev(fixture)['amazon-bedrock/us.deepseek.r1-v1:0'].cachedInputPerMtok)
    .toBeNull()
})

test('kind is derived where models.dev has no marker for it', () => {
  const index = projectModelsDev(fixture)
  expect(index['openai/gpt-4o'].kind).toBe('chat')
  expect(index['openai/text-embedding-3-small'].kind).toBe('embedding')
  expect(index['poe/google/veo-3'].kind).toBe('video')
})

test('kind derivation prefers output modality, then family, then zero-cost', () => {
  expect(kindFromModelsDev({ modalities: { output: ['image'] } })).toBe('image')
  expect(kindFromModelsDev({ modalities: { output: ['audio'] } })).toBe('audio')
  expect(kindFromModelsDev({ family: 'gemini-embedding' })).toBe('embedding')
  expect(kindFromModelsDev({ cost: { output: 0 }, temperature: false })).toBe('embedding')
  expect(kindFromModelsDev({ cost: { output: 0 }, temperature: true })).toBe('chat')
  expect(kindFromModelsDev({})).toBe('chat')
})

test('a garbage document projects to an empty index instead of throwing', () => {
  expect(projectModelsDev(null)).toEqual({})
  expect(projectModelsDev('nope')).toEqual({})
  expect(projectModelsDev({ openai: { models: 'not an object' } })).toEqual({})
})

test('a first load fetches and caches the projection', async () => {
  const fetchImpl = okFetch()
  const result = await loadRegistry({ fetchImpl })

  expect(result.status).toBe('fresh')
  expect(result.error).toBeNull()
  expect(result.index['openai/gpt-4o'].contextWindow).toBe(128000)
  expect(fetchImpl).toHaveBeenCalledTimes(1)

  const [cached] = await db.select().from(registryCache)
  expect(cached.url).toBe(URL_DEFAULT)
  expect(Object.keys(cached.payload)).toContain('openai/gpt-4o')
})

test('a fresh cache is reused without fetching', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.status).toBe('cached')
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('a stale cache triggers a refetch', async () => {
  const start = new Date('2026-08-10T00:00:00Z')
  await loadRegistry({ fetchImpl: okFetch(), now: start })

  const fetchImpl = okFetch()
  const later = new Date(start.getTime() + REGISTRY_MAX_AGE_MS + 1)
  const result = await loadRegistry({ fetchImpl, now: later })

  expect(result.status).toBe('fresh')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('force refetches even when the cache is fresh', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = okFetch()

  await loadRegistry({ fetchImpl, force: true })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('a failed fetch falls back to the cache and reports why', async () => {
  await loadRegistry({ fetchImpl: okFetch() })

  const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
  const result = await loadRegistry({ fetchImpl, force: true })

  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/ECONNREFUSED/)
  expect(result.index['openai/gpt-4o']).toBeDefined()
})

test('a failed fetch with no cache degrades to an empty index, not a throw', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch
  const result = await loadRegistry({ fetchImpl })

  expect(result.status).toBe('failed')
  expect(result.error).toMatch(/ENOTFOUND/)
  expect(result.index).toEqual({})
})

test('a non-2xx response is a failure, not an empty catalog overwrite', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}),
  }) as unknown as typeof fetch

  const result = await loadRegistry({ fetchImpl, force: true })
  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/503/)
})

test('an empty document is refused so it cannot wipe a good cache', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const result = await loadRegistry({ fetchImpl: okFetch({}), force: true })

  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/no models/i)
  expect(result.index['openai/gpt-4o']).toBeDefined()
})

test('disabling the registry skips the fetch entirely', async () => {
  await setCatalogSettings({ registryEnabled: false })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.status).toBe('disabled')
  expect(result.index).toEqual({})
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('a read-only load never fetches, even with no cache', async () => {
  const fetchImpl = vi.fn(() => { throw new Error('must not fetch') }) as unknown as typeof fetch

  const result = await loadRegistry({ readOnly: true, fetchImpl })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(result.status).toBe('unfetched')
  expect(result.fetchedAt).toBeNull()
  expect(result.index).toEqual({})
})

test('a read-only load returns the cache without checking staleness', async () => {
  const start = new Date('2026-08-10T00:00:00Z')
  await loadRegistry({ fetchImpl: okFetch(), now: start })

  const fetchImpl = vi.fn(() => { throw new Error('must not fetch') }) as unknown as typeof fetch
  const later = new Date(start.getTime() + REGISTRY_MAX_AGE_MS + 1)

  const result = await loadRegistry({ readOnly: true, fetchImpl, now: later })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(result.status).toBe('cached')
  expect(result.index['openai/gpt-4o']).toBeDefined()
})

test('a read-only load reports disabled without fetching', async () => {
  await setCatalogSettings({ registryEnabled: false })
  const fetchImpl = vi.fn(() => { throw new Error('must not fetch') }) as unknown as typeof fetch

  const result = await loadRegistry({ readOnly: true, fetchImpl })
  expect(result.status).toBe('disabled')
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('the configured URL is what gets fetched and cached', async () => {
  await setCatalogSettings({ registryUrl: 'https://mirror.internal/api.json' })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.url).toBe('https://mirror.internal/api.json')
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://mirror.internal/api.json',
    expect.objectContaining({ headers: { accept: 'application/json' } }),
  )
})
