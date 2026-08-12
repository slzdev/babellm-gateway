import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import {
  createProvider, deleteProvider, listProviders, updateProvider,
} from '@/lib/admin/providers'
import { decryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

test('creates a provider and encrypts its credentials', async () => {
  const row = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-real' },
  })
  expect(row.credentials).not.toContain('sk-real')
  expect(decryptJson<{ apiKey: string }>(row.credentials).apiKey).toBe('sk-real')
})

test('rejects credentials that do not match the adapter', async () => {
  await expect(
    createProvider({ name: 'bad', adapter: 'openai', credentials: { region: 'us-east-1' } }),
  ).rejects.toThrow(/apiKey/i)
})

test('rejects an openai_compatible provider with no base URL', async () => {
  await expect(
    createProvider({
      name: 'xai', adapter: 'openai_compatible', credentials: { apiKey: 'x' },
    }),
  ).rejects.toThrow(/base URL/i)
})

test('accepts bedrock credentials in both auth shapes', async () => {
  await createProvider({
    name: 'bedrock-keys', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
  })
  await createProvider({
    name: 'bedrock-role', adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })
  expect(await listProviders()).toHaveLength(2)
})

test('listProviders masks secrets', async () => {
  await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-abcdefgh1234' },
  })
  const [item] = await listProviders()
  expect(item.maskedCredentials.apiKey).toBe('••••1234')
  expect(JSON.stringify(item)).not.toContain('sk-abcdefgh1234')
})

test('updating without credentials keeps the stored ones', async () => {
  const created = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-original' },
  })
  const updated = await updateProvider(created.id, { name: 'renamed' })
  expect(updated.name).toBe('renamed')
  expect(decryptJson<{ apiKey: string }>(updated.credentials).apiKey).toBe('sk-original')
})

test('updating with credentials replaces them', async () => {
  const created = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-original' },
  })
  const updated = await updateProvider(created.id, { credentials: { apiKey: 'sk-rotated' } })
  expect(decryptJson<{ apiKey: string }>(updated.credentials).apiKey).toBe('sk-rotated')
})

test('deleting a referenced provider is refused with a useful message', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const [model] = await db.insert(virtualModels).values({ name: 'm' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mini',
  })

  await expect(deleteProvider(provider.id)).rejects.toThrow(/route target/i)
})

test('deleting an unreferenced provider succeeds', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  await deleteProvider(provider.id)
  expect(await db.select().from(providers)).toHaveLength(0)
})

test('listProviders reports catalog counts and sync bookkeeping', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
    config: { registryNamespace: 'openai' },
  })
  await db.insert(catalogModels).values([
    { providerId: provider.id, modelId: 'gpt-4o' },
    { providerId: provider.id, modelId: 'gpt-4o-mini' },
  ])
  await db.update(providers).set({
    lastSyncedAt: new Date('2026-08-12T09:00:00Z'),
    lastSyncStatus: 'ok',
    lastSyncSummary: { added: 2, updated: 0, missing: 0, total: 2 },
  }).where(eq(providers.id, provider.id))

  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(2)
  expect(item.registryNamespace).toBe('openai')
  expect(item.lastSyncStatus).toBe('ok')
  expect(item.lastSyncSummary).toEqual({ added: 2, updated: 0, missing: 0, total: 2 })
})

test('a provider with no catalog rows reports zero, not undefined', async () => {
  await createProvider({ name: 'fresh', adapter: 'openai', credentials: { apiKey: 'sk-x' } })
  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(0)
  expect(item.lastSyncedAt).toBeNull()
  expect(item.registryNamespace).toBeNull()
})
