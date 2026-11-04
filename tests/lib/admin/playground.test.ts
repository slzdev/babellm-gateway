import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys, users, catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { listPlaygroundApiKeys, listPlaygroundModels } from '@/lib/admin/playground'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)
afterEach(() => vi.useRealTimers())

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

test('key options are empty when no usable keys exist', async () => {
  expect(await listPlaygroundApiKeys()).toEqual([])
  await db.insert(apiKeys).values([
    { name: 'disabled', keyHash: 'disabled-secret-hash', keyPrefix: 'sk-disabled', enabled: false },
    { name: 'expired', keyHash: 'expired-secret-hash', keyPrefix: 'sk-expired', expiresAt: new Date(Date.now() - 1) },
  ])
  expect(await listPlaygroundApiKeys()).toEqual([])
})

test('key options include only safe fields and stable duplicate-name ordering', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada', email: 'private@example.test', notes: 'private' }).returning()
  await db.insert(apiKeys).values([
    { id: '00000000-0000-4000-8000-000000000003', name: 'Zebra', keyHash: 'secret-z', keyPrefix: 'sk-z' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Shared', keyHash: 'secret-b', keyPrefix: 'sk-b', userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
    { id: '00000000-0000-4000-8000-000000000001', name: 'Shared', keyHash: 'secret-a', keyPrefix: 'sk-a', logPayloads: true, budgetTotalUsd: '12' },
    { name: 'A disabled', keyHash: 'secret-disabled', keyPrefix: 'sk-d', enabled: false },
    { name: 'A expired', keyHash: 'secret-expired', keyPrefix: 'sk-e', expiresAt: new Date(Date.now() - 1) },
  ])
  expect(await listPlaygroundApiKeys()).toEqual([
    { id: '00000000-0000-4000-8000-000000000001', name: 'Shared', keyPrefix: 'sk-a', userName: null },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Shared', keyPrefix: 'sk-b', userName: 'Ada' },
    { id: '00000000-0000-4000-8000-000000000003', name: 'Zebra', keyPrefix: 'sk-z', userName: null },
  ])
})

test('key eligibility excludes expiry exactly now and includes a later expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T11:00:00Z'))
  const [usable] = await db.insert(apiKeys).values([
    { name: 'usable', keyHash: 'future-key-hash', keyPrefix: 'sk-future', expiresAt: new Date('2026-11-04T11:00:00.001Z') },
    { name: 'expires now', keyHash: 'boundary-key-hash', keyPrefix: 'sk-boundary', expiresAt: new Date('2026-11-04T11:00:00Z') },
  ]).returning()
  expect(await listPlaygroundApiKeys()).toEqual([
    { id: usable.id, name: 'usable', keyPrefix: 'sk-future', userName: null },
  ])
})
