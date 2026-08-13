import { expect, test, vi } from 'vitest'
import { catalogFields, createGeminiClient, listModels } from '@/lib/adapters/gemini/client'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'gemini-prod',
  adapter: 'gemini',
  baseUrl: null,
  credentials: { apiKey: 'g-key' },
  config: {},
  apiFlavor: 'chat_completions',
}

const ctx = { signal: new AbortController().signal }

async function* pager(...models: unknown[]) {
  for (const model of models) yield model
}

function fakeClient(...models: unknown[]) {
  const list = vi.fn().mockResolvedValue(pager(...models))
  return { models: { list } } as never
}

test('the client is built from the api key', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient(runtime, factory)
  expect(factory).toHaveBeenCalledWith({ apiKey: 'g-key' })
})

test('a stored base url is passed as an http option', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient({ ...runtime, baseUrl: 'https://proxy.internal' }, factory)
  expect(factory).toHaveBeenCalledWith({
    apiKey: 'g-key',
    httpOptions: { baseUrl: 'https://proxy.internal' },
  })
})

test('a missing api key fails loudly and names the provider', () => {
  expect(() => createGeminiClient({ ...runtime, credentials: {} }, vi.fn()))
    .toThrow(/gemini-prod/)
})

test('never asks for Vertex', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient(runtime, factory)
  expect(factory.mock.calls[0][0]).not.toHaveProperty('vertexai')
})

test('token limits and actions become catalog fields', () => {
  expect(catalogFields({
    name: 'models/gemini-2.5-flash',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent', 'streamGenerateContent'],
  })).toEqual({
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    kind: 'chat',
  })
})

test('an embedding model is classified as one', () => {
  expect(catalogFields({
    name: 'models/text-embedding-004',
    supportedActions: ['embedContent'],
  })).toMatchObject({ kind: 'embedding', supportsStreaming: false })
})

test('a model reporting nothing contributes nothing', () => {
  expect(catalogFields({ name: 'models/mystery' })).toEqual({})
})

test('discovered ids drop the models/ prefix', async () => {
  const models = await listModels(
    fakeClient({ name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] }),
    ctx,
  )
  expect(models[0].id).toBe('gemini-2.5-flash')
})

test('discovery asks for base models and threads the signal', async () => {
  const client = fakeClient({ name: 'models/gemini-2.5-flash' })
  await listModels(client, ctx)

  expect((client as unknown as { models: { list: ReturnType<typeof vi.fn> } }).models.list)
    .toHaveBeenCalledWith({ config: { queryBase: true, abortSignal: ctx.signal } })
})

test('a nameless entry is skipped rather than stored', async () => {
  const models = await listModels(fakeClient({}, { name: 'models/ok' }), ctx)
  expect(models.map((m) => m.id)).toEqual(['ok'])
})

test('the raw entry is kept for debugging', async () => {
  const entry = { name: 'models/gemini-2.5-flash' }
  const models = await listModels(fakeClient(entry), ctx)
  expect(models[0].raw).toBe(entry)
})
