import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { listPlaygroundModels } from '@/lib/admin/playground'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

async function provider(name = 'alpha', enabled = true) {
  const [row] = await db.insert(providers).values({
    name, enabled, adapter: 'openai', credentials: 'private-provider-credential',
  }).returning()
  return row
}

async function virtual(name: string, providerId: string, upstreamModel: string, enabled = true, targetEnabled = true) {
  const [row] = await db.insert(virtualModels).values({ name, enabled }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: row.id, providerId, upstreamModel, enabled: targetEnabled,
  })
  return row
}

test('returns no options for an empty configuration', async () => {
  expect(await listPlaygroundModels()).toEqual([])
})

test('lists virtual options first and direct models by provider/model with only safe fields', async () => {
  const beta = await provider('beta')
  const alpha = await provider()
  await db.insert(catalogModels).values([
    { providerId: beta.id, modelId: 'z-chat', kind: 'chat' },
    { providerId: alpha.id, modelId: 'z-unknown', kind: 'unknown' },
    { providerId: alpha.id, modelId: 'a-chat', kind: 'chat' },
  ])
  await virtual('z-house', alpha.id, 'a-chat')
  await virtual('a-house', beta.id, 'z-chat')

  expect(await listPlaygroundModels()).toEqual([
    { value: 'a-house', label: 'a-house', group: 'Virtual models' },
    { value: 'z-house', label: 'z-house', group: 'Virtual models' },
    { value: 'alpha/a-chat', label: 'a-chat', group: 'alpha' },
    { value: 'alpha/z-unknown', label: 'z-unknown', group: 'alpha' },
    { value: 'beta/z-chat', label: 'z-chat', group: 'beta' },
  ])
})

test('omits disabled providers, virtual models and targets while keeping direct catalog options', async () => {
  const active = await provider()
  const inactive = await provider('disabled', false)
  await db.insert(catalogModels).values([
    { providerId: active.id, modelId: 'chat', kind: 'chat' },
    { providerId: inactive.id, modelId: 'chat', kind: 'chat' },
  ])
  await virtual('disabled-model', active.id, 'chat', false)
  await virtual('disabled-target', active.id, 'chat', true, false)
  await virtual('disabled-provider', inactive.id, 'chat')
  await db.insert(virtualModels).values({ name: 'no-targets' })

  expect(await listPlaygroundModels()).toEqual([
    { value: 'alpha/chat', label: 'chat', group: 'alpha' },
  ])
})

test('excludes known non-chat models but accepts unknown and uncatalogued virtual targets', async () => {
  const p = await provider()
  await db.insert(catalogModels).values([
    { providerId: p.id, modelId: 'embedding', kind: 'embedding' },
    { providerId: p.id, modelId: 'audio', kind: 'audio' },
    { providerId: p.id, modelId: 'image', kind: 'image' },
    { providerId: p.id, modelId: 'video', kind: 'video' },
    { providerId: p.id, modelId: 'unknown', kind: 'unknown' },
  ])
  await virtual('embed-only', p.id, 'embedding')
  await virtual('audio-only', p.id, 'audio')
  const mixed = await virtual('mixed', p.id, 'embedding')
  await db.insert(routeTargets).values({ virtualModelId: mixed.id, providerId: p.id, upstreamModel: 'unknown' })
  await virtual('uncatalogued', p.id, 'not-in-catalog')

  expect(await listPlaygroundModels()).toEqual([
    { value: 'mixed', label: 'mixed', group: 'Virtual models' },
    { value: 'uncatalogued', label: 'uncatalogued', group: 'Virtual models' },
    { value: 'alpha/unknown', label: 'unknown', group: 'alpha' },
  ])
})

test('preserves missing catalog entries and slashes in upstream model IDs', async () => {
  const p = await provider()
  await db.insert(catalogModels).values({
    providerId: p.id, modelId: 'org/model/v2', kind: 'chat', status: 'missing',
  })
  await virtual('house', p.id, 'org/model/v2')
  expect(await listPlaygroundModels()).toEqual([
    { value: 'house', label: 'house', group: 'Virtual models' },
    { value: 'alpha/org/model/v2', label: 'org/model/v2', group: 'alpha' },
  ])
})

test('an enabled virtual name shadows a direct address even when it has no eligible targets', async () => {
  const p = await provider()
  await db.insert(catalogModels).values([
    { providerId: p.id, modelId: 'chat', kind: 'chat' },
    { providerId: p.id, modelId: 'blocked', kind: 'chat' },
    { providerId: p.id, modelId: 'embedding', kind: 'embedding' },
  ])
  await virtual('alpha/chat', p.id, 'chat')
  await virtual('alpha/blocked', p.id, 'embedding')
  expect(await listPlaygroundModels()).toEqual([
    { value: 'alpha/chat', label: 'alpha/chat', group: 'Virtual models' },
  ])
})

test('a disabled virtual name does not shadow a direct address', async () => {
  const p = await provider()
  await db.insert(catalogModels).values({ providerId: p.id, modelId: 'chat', kind: 'chat' })
  await virtual('alpha/chat', p.id, 'chat', false)
  expect(await listPlaygroundModels()).toEqual([
    { value: 'alpha/chat', label: 'chat', group: 'alpha' },
  ])
})
