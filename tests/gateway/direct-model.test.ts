import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { db } from '@/lib/db'
import { apiKeys, catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { generateApiKey } from '@/lib/gateway/auth'
import { chatRequest, fakeAdapterDeps } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'grok-4.5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

/** A provider with a catalog, and no virtual model anywhere in sight. */
async function seedCatalogOnly(adapter: 'openai_compatible' | 'gemini' = 'openai_compatible') {
  const [provider] = await db.insert(providers).values({
    name: 'xai',
    adapter,
    credentials: encryptJson({ apiKey: 'sk-upstream' }),
  }).returning()

  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'grok-4.5' })

  const generated = generateApiKey()
  await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
  })

  return { provider, apiKey: generated.key }
}

function directBody(model: string) {
  return { model, messages: [{ role: 'user', content: 'hi' }] }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('routes `provider/model` to that provider with no virtual model defined', async () => {
  const { apiKey } = await seedCatalogOnly()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const res = await handleChatCompletions(
    chatRequest(directBody('xai/grok-4.5'), apiKey),
    fakeAdapterDeps({ chat }),
  )
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(chat.mock.calls[0][1].upstreamModel).toBe('grok-4.5')
  expect(res.headers.get('x-babellm-provider')).toBe('xai')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('grok-4.5')
  // The client asked for `xai/grok-4.5`, so that is the name it gets back.
  expect(json.model).toBe('xai/grok-4.5')
  expect(json.choices[0].message.content).toBe('hello')
})

test('streams a `provider/model` request', async () => {
  const { apiKey } = await seedCatalogOnly()
  const chunk = {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'grok-4.5',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  }
  const chatStream = vi.fn().mockImplementation(async function* () {
    yield chunk
  })

  const res = await handleChatCompletions(
    chatRequest({ ...directBody('xai/grok-4.5'), stream: true }, apiKey),
    fakeAdapterDeps({ chatStream }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-upstream-model')).toBe('grok-4.5')
  expect(await res.text()).toContain('"model":"xai/grok-4.5"')
})

test('answers 501 for a direct address on a provider with no adapter', async () => {
  const { apiKey } = await seedCatalogOnly('gemini')

  // Deliberately the real adapter registry: a direct address is a chain of
  // one, so execute's "skip this target and let a sibling serve" path has no
  // sibling to fall to and must still surface the real reason.
  const res = await handleChatCompletions(chatRequest(directBody('xai/grok-4.5'), apiKey))
  const json = await res.json()

  expect(res.status).toBe(501)
  expect(json.error.code).toBe('unsupported_operation')
})

test('answers 404 for a model the provider’s catalog does not list', async () => {
  const { apiKey } = await seedCatalogOnly()
  const chat = vi.fn()

  const res = await handleChatCompletions(
    chatRequest(directBody('xai/grok-9'), apiKey),
    fakeAdapterDeps({ chat }),
  )
  const json = await res.json()

  expect(res.status).toBe(404)
  expect(json.error.code).toBe('model_not_found')
  expect(chat).not.toHaveBeenCalled()
})
