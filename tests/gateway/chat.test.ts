import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { chatRequest, fakeAdapterDeps, seedGateway, seedPrices } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { clearPriceCache } from '@/lib/pricing'
import * as pricing from '@/lib/pricing'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  clearPriceCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('returns a completion with gateway identity', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.model).toBe('house-model')
  expect(json.id).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(json.choices[0].message.content).toBe('hello')
  expect(json.usage.total_tokens).toBe(7)
})

test('passes the upstream model name to the adapter', async () => {
  const { apiKey } = await seedGateway({ upstreamModel: 'gpt-5-nano' })
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(chat.mock.calls[0][1].upstreamModel).toBe('gpt-5-nano')
})

test('reports the provider and upstream model in response headers', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  expect(res.headers.get('x-request-id')).toBeTruthy()
})

test('rejects a request with no API key', async () => {
  await seedGateway()
  const res = await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))
  expect(res.status).toBe(401)
  expect((await res.json()).error.code).toBe('missing_api_key')
})

test('rejects malformed JSON with 400', async () => {
  const { apiKey } = await seedGateway()
  const request = new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: '{ not json',
  })

  const res = await handleChatCompletions(request, fakeAdapterDeps({}))
  expect(res.status).toBe(400)
  expect((await res.json()).error.type).toBe('invalid_request_error')
})

test('rejects a schema violation with 400 and names the parameter', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest({ model: 'house-model', messages: [] }, apiKey),
    fakeAdapterDeps({}),
  )
  expect(res.status).toBe(400)
  expect((await res.json()).error.param).toBe('messages')
})

test('rejects an unknown virtual model with 404', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest({ ...body, model: 'nope' }, apiKey),
    fakeAdapterDeps({}),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('model_not_found')
})

test('surfaces an upstream error with its status and message', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockRejectedValue(
    new OpenAI.APIError(400, { message: 'context_length_exceeded', code: 'context_length_exceeded' }, 'context_length_exceeded', undefined),
  )

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('context_length_exceeded')
})

test('propagates an upstream 500 as 500 with type api_error', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockRejectedValue(
    new OpenAI.APIError(500, { message: 'server error', code: 'server_error' }, 'server error', undefined),
  )

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.status).toBe(500)
  expect((await res.json()).error.type).toBe('api_error')
})

test('a bedrock target returns 501 unsupported_operation instead of an opaque 500', async () => {
  // Regression test: createAdapter() (which throws UnsupportedOperationError
  // for adapters not yet implemented) used to sit outside the try/catch that
  // classifies provider errors, so this fell through to a bare 500.
  // Exercised with the real registry (no deps override) since the bug lived
  // in how the handler wraps deps.createAdapter, not in a fake.
  const { apiKey } = await seedGateway({
    adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })

  const res = await handleChatCompletions(chatRequest(body, apiKey))
  const json = await res.json()

  expect(res.status).toBe(501)
  expect(json.error.code).toBe('unsupported_operation')
})

test('records last_used_at on the key', async () => {
  const { apiKey, key } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))

  // touchApiKey is fire-and-forget by design (the response must not wait on
  // the last-used write), so give the in-flight update a bounded window to
  // land before asserting on it instead of racing it with a bare select.
  let updated: typeof key
  const deadline = Date.now() + 1000
  do {
    ;[updated] = await db.select().from(apiKeys)
    if (updated.lastUsedAt) break
  } while (Date.now() < deadline)

  expect(updated!.lastUsedAt).toBeInstanceOf(Date)
  expect(updated!.id).toBe(key.id)
})

const pricedCompletion = {
  ...upstreamCompletion,
  usage: {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 0 },
  },
}

test('returns the cost breakdown inside usage', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(json.usage.cost).toEqual({
    currency: 'USD',
    input: '1.000000000',
    cached: '0.000000000',
    output: '3.000000000',
    total: '4.000000000',
  })
})

test('leaves the token counts untouched when attaching cost', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(json.usage.prompt_tokens).toBe(1_000_000)
  expect(json.usage.completion_tokens).toBe(1_000_000)
  expect(json.usage.total_tokens).toBe(2_000_000)
})

test('never publishes the catalog rates to the client', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )

  expect(JSON.stringify(await res.json())).not.toContain('per_mtok')
})

test('bills cached tokens at the cached rate without double-charging the prompt', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '0',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({
      chat: vi.fn().mockResolvedValue({
        ...upstreamCompletion,
        usage: {
          prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000,
          prompt_tokens_details: { cached_tokens: 400_000 },
        },
      }),
    }),
  )
  const json = await res.json()

  // 600k at the full rate + 400k cached — not 1M at full plus a second charge.
  expect(json.usage.cost.input).toBe('0.600000000')
  expect(json.usage.cost.cached).toBe('0.100000000')
  expect(json.usage.cost.total).toBe('0.700000000')
})

test('an unpriced model returns an explicit null cost, not zeroes', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  // Null, not absent: a client must be able to tell "this model has no catalog
  // price" from "this gateway predates the feature".
  expect(json.usage).toHaveProperty('cost')
  expect(json.usage.cost).toBeNull()
})

test('a half-priced catalog row returns null rather than half a cost', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', { inputPerMtok: '1.000000' })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )

  expect((await res.json()).usage.cost).toBeNull()
})

test('a response with no usage gets no fabricated usage object', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
  const noUsage: Record<string, unknown> = { ...upstreamCompletion }
  delete noUsage.usage

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(noUsage) }),
  )
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.usage).toBeUndefined()
})

test('a catalog lookup failure costs the breakdown, not the completion', async () => {
  const { apiKey } = await seedGateway()
  vi.spyOn(pricing, 'priceFor').mockRejectedValue(new Error('catalog is down'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.choices[0].message.content).toBe('hello')
  expect(json.usage.cost).toBeNull()
})
