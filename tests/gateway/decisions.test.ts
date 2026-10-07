import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, catalogModels, providers } from '@/lib/db/schema'
import { handleDecisions } from '@/lib/gateway/decisions-handler'
import { resetHealthStore } from '@/lib/health'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { listCatalog, setModelGateway } from '@/lib/admin/catalog'
import { resolveModel } from '@/lib/gateway/resolve'
import { withModelPaths } from '@/lib/adapters/registry'
import { resolveRequestPaths, mergeProviderPaths } from '@/lib/adapters/paths'
import { fakeAdapterByProvider, fakeAdapterDeps, seedGateway as seedBaseGateway, seedPrices, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { waitForLogs } from '../helpers/logs'

const body = { model: 'house-model', input: 'Broken screen', questions: [
  { type: 'predicate', instructions: 'Damaged?', name: 'damaged' },
  { type: 'choice', instructions: 'Pick', choices: [{ value: true }, { value: 'true' }] },
  { type: 'score', instructions: 'Rate', levels: [{ label: 'low' }, { label: 'high' }] },
  { type: 'predicate', instructions: 'Private?' },
] }
const upstream = {
  model: 'gpt-4o-mini', answers: [
    { type: 'predicate', name: 'damaged', probability: 0.95 },
    { type: 'choice', name: null, choice: true, confidence: 0.8, probabilities: [{ value: true, probability: 0.8 }, { value: 'true', probability: 0.2 }] },
    { type: 'score', name: null, score: 0.75, confidence: 0.9, probabilities: [{ label: 'low', value: 0, probability: 0.25 }, { label: 'high', value: 1, probability: 0.75 }] },
    { type: 'refusal', name: null },
  ], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 7 },
    output_tokens_details: { reasoning_tokens: 4 }, compute_units: 9, extension: 'retained',
  }, extension: { retained: true },
}
function request(apiKey: string | null, payload: unknown = body, headers: Record<string, string> = {}) {
  return new Request('http://gateway.test/v1/decisions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
    body: JSON.stringify(payload),
  })
}
const seedGateway = (options: Parameters<typeof seedBaseGateway>[0] = {}) => seedBaseGateway({ apiFlavor: 'decisions', ...options })
const deps = () => fakeAdapterDeps({ decide: async () => upstream as never })
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
  resetHealthStore()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => { await waitForLogs(); vi.restoreAllMocks(); resetHealthStore() })

test('returns ordered answers/refusals, rewrites only model and preserves complete usage', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleDecisions(request(apiKey), deps())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ...upstream, model: 'house-model', usage: { ...upstream.usage, cost: null } })
  expect(res.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  expect(res.headers.get('x-request-id')).toBeTruthy()
})

test('prices tokens once, charges key limits and logs captured payload/tags', async () => {
  const { apiKey, provider, key } = await seedGateway({ limits: { tpmLimit: 110 } })
  await seedPrices(provider.id, 'gpt-4o-mini', { inputPerMtok: '1.000000', cachedInputPerMtok: '0.500000', outputPerMtok: '2.000000' })
  await db.update(apiKeys).set({ logPayloads: true }).where(eq(apiKeys.id, key.id))
  const res = await handleDecisions(request(apiKey, body, { 'x-babellm-tags': 'pipeline=decisions' }), deps())
  const json = await res.json()
  expect(json.usage.cost).toEqual({ currency: 'USD', input: '0.000080000', cached: '0.000010000', output: '0.000020000', total: '0.000110000' })
  await waitForLogs()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ model: 'house-model', stream: false, status: 200, promptTokens: 100, completionTokens: 10, costUsd: '0.000110000', tags: { pipeline: 'decisions' } })
  const detail = await postgresStore.get(row.id)
  expect(detail?.payload?.request).toEqual(body)
  expect(detail?.payload?.response).toEqual(json)
  const limited = await handleDecisions(request(apiKey), deps())
  expect(limited.status).toBe(429)
})

test.each([null, 'sk-bab-invalid'])('requires a valid gateway key: %s', async (key) => {
  await seedGateway()
  const decide = vi.fn()
  expect((await handleDecisions(request(key), fakeAdapterDeps({ decide }))).status).toBe(401)
  expect(decide).not.toHaveBeenCalled()
})

test('rejects streaming before making an upstream call', async () => {
  const { apiKey } = await seedGateway()
  const decide = vi.fn()
  const res = await handleDecisions(request(apiKey, { ...body, stream: true }), fakeAdapterDeps({ decide }))
  expect(res.status).toBe(400)
  expect((await res.json()).error.param).toBe('stream')
  expect(decide).not.toHaveBeenCalled()
})

test('steers wrong flavors and unsupported adapters before maxAttempts to a Decisions model', async () => {
  const { apiKey } = await seedTargets({ maxAttempts: 1, targets: [
    { name: 'gem', adapter: 'gemini', apiFlavor: 'decisions', priority: 0 },
    { name: 'bed', adapter: 'bedrock', apiFlavor: 'decisions', priority: 1 },
    { name: 'chat', priority: 2 },
    { name: 'responses', apiFlavor: 'responses', priority: 3 },
    { name: 'anthropic', apiFlavor: 'anthropic_messages', priority: 4 },
    { name: 'clone', apiFlavor: 'decisions', priority: 5 },
  ] })
  const never = vi.fn()
  const res = await handleDecisions(request(apiKey), fakeAdapterByProvider({
    gem: { decide: never }, bed: { decide: never }, chat: { decide: never }, responses: { decide: never }, anthropic: { decide: never }, clone: { decide: async () => upstream as never },
  }))
  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('clone')
  expect(never).not.toHaveBeenCalled()
  await waitForLogs()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
})

test.each(['gemini', 'bedrock'] as const)('an unsupported-only %s chain returns 501 with no upstream call', async (adapter) => {
  const { apiKey } = await seedGateway({ adapter })
  const transport = vi.spyOn(globalThis, 'fetch')
  const res = await handleDecisions(request(apiKey))
  expect(res.status).toBe(501)
  expect((await res.json()).error).toMatchObject({ code: 'unsupported_operation', message: expect.stringContaining('Decisions API') })
  expect(transport).not.toHaveBeenCalled()
})

test('a Decisions-flavored OpenAI clone calls the dedicated Decisions endpoint through the real registry', async () => {
  const { apiKey, targets } = await seedTargets({ targets: [{ name: 'clone', apiFlavor: 'decisions', adapter: 'openai_compatible' }] })
  await db.update(providers).set({ baseUrl: 'https://clone.example/gwt/v1', config: JSON.stringify({ decisionsPath: '/api/decide' }) }).where(eq(providers.id, targets[0].provider.id))
  let sentUrl: string | undefined
  let sentBody: unknown
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sentUrl = String(url)
    sentBody = JSON.parse(init!.body as string)
    return Response.json(upstream)
  })
  const res = await handleDecisions(request(apiKey))
  expect(res.status).toBe(200)
  expect(sentUrl).toBe('https://clone.example/api/decide')
  expect(sentBody).toEqual({ ...body, model: 'clone-model' })
})

test('retryable failure walks to backup and records both attempts', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'primary', apiFlavor: 'decisions' }, { name: 'backup', apiFlavor: 'decisions', priority: 1 }] })
  const res = await handleDecisions(request(apiKey), fakeAdapterByProvider({
    primary: { decide: async () => { throw new OpenAI.APIError(429, { message: 'slow' }, 'slow', undefined) } },
    backup: { decide: async () => upstream as never },
  }))
  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  await waitForLogs()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts.map((a) => a.status)).toEqual([429, 200])
})

test('reports a pinned tier as dropped without injecting it', async () => {
  const { apiKey } = await seedGateway({ serviceTier: 'priority' })
  let forwarded: unknown
  const res = await handleDecisions(request(apiKey), fakeAdapterDeps({ decide: async (req) => { forwarded = req; return upstream as never } }))
  expect(forwarded).toEqual(body)
  expect(res.headers.get('x-babellm-dropped-params')).toBe('service_tier')
})

test('persists model/provider paths and inherits/overrides them for virtual and direct addresses', async () => {
  const { apiKey, provider } = await seedGateway()
  const config = mergeProviderPaths({}, { decisionsPath: ' /provider/decide/ ' })
  await db.update(providers).set({ config: JSON.stringify(config) }).where(eq(providers.id, provider.id))
  const [catalog] = await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-4o-mini' }).returning()
  expect((await listCatalog())[0].providerPaths.decisionsPath).toBe('/provider/decide')
  await setModelGateway(catalog.id, { decisionsPath: '/model/decide' })
  expect((await listCatalog())[0].decisionsPath).toBe('/model/decide')
  for (const model of ['house-model', 'test-provider/gpt-4o-mini']) {
    const candidate = (await resolveModel(model)).candidates[0]
    const runtime = withModelPaths({ id: provider.id, name: provider.name, adapter: 'openai', credentials: {}, baseUrl: 'https://example.com/prefix/v1', config }, candidate.pathOverrides)
    expect(resolveRequestPaths(runtime.config, runtime.baseUrl).decisions).toBe('https://example.com/model/decide')
    expect((await (await handleDecisions(request(apiKey, { ...body, model }), deps())).json()).model).toBe(model)
  }
  await setModelGateway(catalog.id, { decisionsPath: '' })
  expect((await listCatalog())[0].decisionsPath).toBeNull()
  const candidate = (await resolveModel('house-model')).candidates[0]
  const runtime = withModelPaths({ id: provider.id, name: provider.name, adapter: 'openai', credentials: {}, baseUrl: 'https://example.com/prefix/v1', config }, candidate.pathOverrides)
  expect(resolveRequestPaths(runtime.config, runtime.baseUrl).decisions).toBe('https://example.com/provider/decide')
})

test('a large malformed inline image returns invalid-request 400 before calling upstream', async () => {
  const { apiKey } = await seedGateway()
  const decide = vi.fn()
  const res = await handleDecisions(request(apiKey, {
    ...body, input: [{ role: 'user', content: [{
      type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(7_999_999)}!`,
    }] }],
  }), fakeAdapterDeps({ decide }))
  expect(res.status).toBe(400)
  expect((await res.json()).error.type).toBe('invalid_request_error')
  expect(decide).not.toHaveBeenCalled()
})


test.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('wrong-flavor %s returns an actionable 501 without fetch', async (apiFlavor) => {
  const { apiKey, provider } = await seedGateway()
  await db.update(providers).set({ apiFlavor }).where(eq(providers.id, provider.id))
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(upstream))
  const res = await handleDecisions(request(apiKey))
  expect(res.status).toBe(501)
  expect((await res.json()).error.message).toContain('Decisions API')
  expect(transport).not.toHaveBeenCalled()
})


test('resolved model overrides and provider inheritance control virtual and direct Decisions eligibility', async () => {
  const { apiKey, provider } = await seedBaseGateway()
  const [catalog] = await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-4o-mini' }).returning()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(upstream))
  for (const apiFlavor of ['decisions', 'chat_completions', null] as const) {
    await db.update(providers).set({ apiFlavor: 'decisions' }).where(eq(providers.id, provider.id))
    await setModelGateway(catalog.id, { apiFlavor })
    const [item] = await listCatalog()
    expect(item.apiFlavor).toBe(apiFlavor)
    expect(item.providerApiFlavor).toBe('decisions')
    for (const model of ['house-model', 'test-provider/gpt-4o-mini']) {
      expect((await resolveModel(model)).candidates[0].apiFlavor).toBe(apiFlavor ?? 'decisions')
      const res = await handleDecisions(request(apiKey, { ...body, model }))
      expect(res.status).toBe(apiFlavor === 'chat_completions' ? 501 : 200)
    }
  }
})

test('all-ineligible Decisions refusal logs status and releases limits without constructing an adapter', async () => {
  const { apiKey } = await seedBaseGateway({ limits: { tpmLimit: 1 } })
  const createAdapter = vi.fn()
  for (let n = 0; n < 2; n++) {
    const res = await handleDecisions(request(apiKey), { createAdapter })
    expect(res.status).toBe(501)
    expect((await res.json()).error.code).toBe('unsupported_operation')
  }
  expect(createAdapter).not.toHaveBeenCalled()
  await waitForLogs()
  const rows = (await postgresStore.query({ limit: 2 })).rows
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row).toMatchObject({ status: 501, stream: false, model: 'house-model' })
    expect(await postgresStore.get(row.id)).toMatchObject({ errorCode: 'unsupported_operation', attempts: [] })
  }
})
