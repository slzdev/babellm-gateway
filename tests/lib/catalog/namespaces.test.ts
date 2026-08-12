import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { registryCache } from '@/lib/db/schema'
import { listRegistryNamespaces } from '@/lib/catalog/namespaces'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  await resetDb()
})

const URL = 'https://models.dev/api.json'

async function cacheKeys(keys: string[]) {
  await db.insert(registryCache).values({
    url: URL,
    payload: Object.fromEntries(keys.map((key) => [key, {}])),
  })
}

test('an empty cache still offers every namespace the snapshot knows', async () => {
  const namespaces = await listRegistryNamespaces()

  expect(namespaces.length).toBeGreaterThan(100)
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
})

test('a namespace only the live cache knows is offered, without a name', async () => {
  await cacheKeys(['brand-new-co/model-1', 'xai/grok-9'])

  expect(await listRegistryNamespaces()).toContainEqual({ slug: 'brand-new-co', name: null })
})

test('a namespace in both sources appears once, keeping its display name', async () => {
  await cacheKeys(['xai/grok-9'])

  const namespaces = await listRegistryNamespaces()

  expect(namespaces.filter((namespace) => namespace.slug === 'xai'))
    .toEqual([{ slug: 'xai', name: 'xAI' }])
})

test('a key with no slash is not offered as a namespace', async () => {
  // split_part returns the whole string when the delimiter is absent, so
  // without a guard this key would surface as a namespace of its own.
  await cacheKeys(['no-slash-key', '/leading-slash'])

  const slugs = (await listRegistryNamespaces()).map((namespace) => namespace.slug)

  expect(slugs).not.toContain('no-slash-key')
  expect(slugs).not.toContain('')
})

test('namespaces come back sorted by slug', async () => {
  await cacheKeys(['zzz-last/model', 'aaa-first/model'])

  const slugs = (await listRegistryNamespaces()).map((namespace) => namespace.slug)

  expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)))
})

test('a failing cache query degrades to the snapshot instead of throwing', async () => {
  // The providers page must render even when this query cannot.
  const queryImpl = vi.fn().mockRejectedValue(new Error('relation does not exist'))

  const namespaces = await listRegistryNamespaces({ queryImpl })

  expect(queryImpl).toHaveBeenCalled()
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
  expect(namespaces.length).toBeGreaterThan(100)
})
