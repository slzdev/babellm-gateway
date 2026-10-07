import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import {
  createProvider, deleteProvider, listProviders, testProvider, updateProvider,
} from '@/lib/admin/providers'
import { decryptJson } from '@/lib/crypto'
import { decisionsRequestSchema } from '@/lib/schemas/decisions'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

afterEach(() => { vi.restoreAllMocks() })

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

test('updating credentials merges onto the stored ones, preserving unsubmitted fields', async () => {
  const created = await createProvider({
    name: 'openai-prod', adapter: 'openai',
    credentials: { apiKey: 'sk-original', organization: 'org-1' },
  })
  // Only apiKey is submitted — organization is never sent because the form
  // never echoes it back, yet it must survive the edit rather than being
  // dropped by a whole-object replace.
  const updated = await updateProvider(created.id, { credentials: { apiKey: 'sk-rotated' } })
  const stored = decryptJson<{ apiKey: string; organization?: string }>(updated.credentials)
  expect(stored.apiKey).toBe('sk-rotated')
  expect(stored.organization).toBe('org-1')
})

test('a bedrock edit that only touches one field succeeds via merge', async () => {
  const created = await createProvider({
    name: 'bedrock-keys', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
  })
  // A whole-object replace with only { region } would fail bedrock's
  // credential union (neither branch is satisfied by region alone).
  const updated = await updateProvider(created.id, { credentials: { region: 'us-west-2' } })
  const stored = decryptJson<{ region: string; accessKeyId: string; secretAccessKey: string }>(
    updated.credentials,
  )
  expect(stored.region).toBe('us-west-2')
  expect(stored.accessKeyId).toBe('AK')
  expect(stored.secretAccessKey).toBe('SK')
})

test('switching adapter type replaces credentials instead of merging the old shape', async () => {
  const created = await createProvider({
    name: 'flexible', adapter: 'openai',
    credentials: { apiKey: 'sk-x', organization: 'org-1' },
  })
  const updated = await updateProvider(created.id, {
    adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })
  expect(decryptJson<Record<string, unknown>>(updated.credentials)).toEqual({
    region: 'us-east-1', useInstanceRole: true,
  })
})

test('checking useInstanceRole on a bedrock edit drops the old access keys', async () => {
  const created = await createProvider({
    name: 'bedrock-keys', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
  })
  const updated = await updateProvider(created.id, {
    credentials: { useInstanceRole: true },
  })
  expect(decryptJson<Record<string, unknown>>(updated.credentials)).toEqual({
    region: 'us-east-1', useInstanceRole: true,
  })
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
    lastSyncSummary: { added: 2, updated: 0, missing: 0, matched: 1, total: 2 },
  }).where(eq(providers.id, provider.id))

  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(2)
  expect(item.registryNamespace).toBe('openai')
  expect(item.lastSyncStatus).toBe('ok')
  expect(item.lastSyncSummary).toEqual({ added: 2, updated: 0, missing: 0, matched: 1, total: 2 })
})

test('listProviders exposes stored path overrides, so the edit form can prefill them', async () => {
  await createProvider({
    name: 'clone', adapter: 'openai_compatible', baseUrl: 'https://api.example/v1',
    credentials: { apiKey: 'sk-x' },
    config: { modelsPath: '/api/v2/models', timeoutMs: 5000 },
  })
  const [item] = await listProviders()
  expect(item.pathOverrides).toEqual({ modelsPath: '/api/v2/models' })
})

test('a provider that overrides no path reports an empty set, not undefined', async () => {
  await createProvider({ name: 'plain', adapter: 'openai', credentials: { apiKey: 'sk-x' } })
  const [item] = await listProviders()
  expect(item.pathOverrides).toEqual({})
})

test('a provider with no catalog rows reports zero, not undefined', async () => {
  await createProvider({ name: 'fresh', adapter: 'openai', credentials: { apiKey: 'sk-x' } })
  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(0)
  expect(item.lastSyncedAt).toBeNull()
  expect(item.registryNamespace).toBeNull()
})

test('a provider is created with the chat_completions flavor by default', async () => {
  const row = await createProvider({
    name: 'plain', adapter: 'openai', credentials: { apiKey: 'sk-a' },
  })
  expect(row.apiFlavor).toBe('chat_completions')
})

test('a provider can be created with the responses flavor', async () => {
  const row = await createProvider({
    name: 'resp', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  expect(row.apiFlavor).toBe('responses')
})

test('updating a provider can change its flavor', async () => {
  const created = await createProvider({
    name: 'switch', adapter: 'openai', credentials: { apiKey: 'sk-a' },
  })
  const updated = await updateProvider(created.id, { apiFlavor: 'responses' })
  expect(updated.apiFlavor).toBe('responses')
})

test('an update that omits the flavor keeps the stored one', async () => {
  const created = await createProvider({
    name: 'keep', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  const updated = await updateProvider(created.id, { name: 'keep-renamed' })
  expect(updated.apiFlavor).toBe('responses')
})

test('listProviders reports each provider flavor', async () => {
  await createProvider({
    name: 'resp', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  const [item] = await listProviders()
  expect(item.apiFlavor).toBe('responses')
})


test.each(['openai', 'openai_compatible'] as const)('persists the Decisions flavor through %s provider create, edit and list', async (adapter) => {
  const created = await createProvider({
    name: 'decision-provider', adapter, credentials: { apiKey: 'sk-a' },
    baseUrl: adapter === 'openai_compatible' ? 'https://clone.example/v1' : undefined,
    apiFlavor: 'decisions',
  })
  expect((await listProviders())[0].apiFlavor).toBe('decisions')
  await updateProvider(created.id, { apiFlavor: 'chat_completions' })
  expect((await listProviders())[0].apiFlavor).toBe('chat_completions')
  await updateProvider(created.id, { apiFlavor: 'decisions' })
  await updateProvider(created.id, { name: 'renamed' })
  const [stored] = await db.select().from(providers).where(eq(providers.id, created.id))
  expect(stored.apiFlavor).toBe('decisions')
})


const decisionsProbes = [
  { adapter: 'openai' as const, baseUrl: undefined, config: {}, expectedUrl: 'https://api.openai.com/v1/decisions' },
  { adapter: 'openai_compatible' as const, baseUrl: 'https://clone.example/prefix/v1', config: {}, expectedUrl: 'https://clone.example/prefix/v1/decisions' },
  { adapter: 'openai' as const, baseUrl: 'https://api.openai.com/v1', config: { decisionsPath: '/gateway/classify' }, expectedUrl: 'https://api.openai.com/gateway/classify' },
  { adapter: 'openai_compatible' as const, baseUrl: 'https://clone.example/prefix/v1', config: { decisionsPath: '/gateway/classify' }, expectedUrl: 'https://clone.example/gateway/classify' },
]

test.each(decisionsProbes)('connection probe calls Decisions for $adapter at $expectedUrl', async ({ adapter, baseUrl, config, expectedUrl }) => {
  const provider = await createProvider({ name: 'decision-probe', adapter, baseUrl, config, credentials: { apiKey: 'sk-probe' }, apiFlavor: 'decisions' })
  let sentUrl: string | undefined
  let sentBody: unknown
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sentUrl = String(url)
    sentBody = JSON.parse(init!.body as string)
    return Response.json({ model: 'decision-upstream', answers: [{ type: 'predicate', name: null, probability: 1 }], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } })
  })
  expect(await testProvider(provider.id, 'decision-upstream')).toEqual({ ok: true, message: 'Connection succeeded.' })
  expect(sentUrl).toBe(expectedUrl)
  expect(sentBody).toMatchObject({ model: 'decision-upstream', input: 'ping', questions: [{ type: 'predicate', instructions: expect.any(String) }] })
  expect(decisionsRequestSchema.safeParse(sentBody).success).toBe(true)
})

test.each(['openai', 'openai_compatible'] as const)('connection probe reports the upstream Decisions error for %s', async (adapter) => {
  const provider = await createProvider({ name: 'decision-error-probe', adapter, baseUrl: adapter === 'openai_compatible' ? 'https://clone.example/v1' : undefined, credentials: { apiKey: 'sk-probe' }, apiFlavor: 'decisions' })
  let sentUrl: string | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    sentUrl = String(url)
    return Response.json({ error: { message: 'This Decisions model is unavailable.' } }, { status: 400 })
  })
  expect(await testProvider(provider.id, 'decision-upstream')).toMatchObject({ ok: false, message: expect.stringContaining('This Decisions model is unavailable.') })
  expect(sentUrl).toMatch(/\/decisions$/)
})

test('connection probe retains OpenAI chat behavior for chat providers', async () => {
  const provider = await createProvider({ name: 'chat-probe', adapter: 'openai', credentials: { apiKey: 'sk-probe' } })
  let sentUrl: string | undefined
  let sentBody: unknown
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sentUrl = String(url)
    sentBody = JSON.parse(init!.body as string)
    return Response.json({ id: 'probe', object: 'chat.completion', created: 1, model: 'chat-upstream', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })
  })
  expect(await testProvider(provider.id, 'chat-upstream')).toEqual({ ok: true, message: 'Connection succeeded.' })
  expect(sentUrl).toBe('https://api.openai.com/v1/chat/completions')
  expect(sentBody).toMatchObject({ model: 'chat-upstream', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
})

test('connection probe keeps Gemini chat even when its flavor is labeled Decisions', async () => {
  const provider = await createProvider({ name: 'gemini-probe', adapter: 'gemini', credentials: { apiKey: 'g-probe' }, apiFlavor: 'decisions' })
  let sentUrl: string | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    sentUrl = String(url)
    return Response.json({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })
  })
  expect(await testProvider(provider.id, 'gemini-upstream')).toEqual({ ok: true, message: 'Connection succeeded.' })
  expect(sentUrl).toContain('models/gemini-upstream:generateContent')
})
