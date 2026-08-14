import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { generateApiKey } from '@/lib/gateway/auth'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { postgresStore } from '@/lib/logs/postgres'
import { setLoggingSettings } from '@/lib/settings'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { getUsageStore, resetUsageStore } from '@/lib/usage'
import { bucketOf, totalSpendKey, windowKey } from '@/lib/usage/keys'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { waitFor } from '../helpers/logs'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

const deps = () => fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) })

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  delete process.env.REDIS_URL
  await resetDb()
  await setLoggingSettings({ store: 'postgres' })
  clearRequestLogStoreCache()
  resetUsageStore()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('a key under its limit is served, with rate limit headers', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 10 } })
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(200)
  expect(res.headers.get('x-ratelimit-limit-requests')).toBe('10')
  expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('9')
  expect(Number(res.headers.get('x-ratelimit-reset-requests'))).toBeGreaterThan(0)
})

test('a key with no limits gets no rate limit headers', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(200)
  expect(res.headers.get('x-ratelimit-limit-requests')).toBeNull()
})

test('a key over its rpm limit is rejected with 429 and Retry-After', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())
  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(429)
  expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(res.headers.get('x-request-id')).toBeTruthy()
  expect((await res.json()).error).toMatchObject({
    type: 'rate_limit_error', code: 'rate_limit_exceeded',
  })
})

test('the upstream is never called for a rejected request', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())

  const chat = vi.fn().mockResolvedValue(upstreamCompletion)
  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))

  expect(chat).not.toHaveBeenCalled()
})

test('a rejection is not written to the request log', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())
  // The served request's log write is fire-and-forget, so wait for it before
  // asserting on the count — otherwise this passes for the wrong reason.
  await waitFor(async () => (await postgresStore.query({ limit: 10 })).rows.length >= 1)

  await handleChatCompletions(chatRequest(body, apiKey), deps())

  // A second, unrelated served request is a real ordering barrier: its log
  // write is only queued after the rejected request's handler call has
  // returned, so if the rejection had queued a write of its own, that write
  // was queued first and this waitFor would see it land too. A fixed sleep
  // would only be a guess at how long that write might take.
  const otherKeyGen = generateApiKey()
  await db.insert(apiKeys).values({
    name: 'other key', keyHash: otherKeyGen.keyHash, keyPrefix: otherKeyGen.keyPrefix,
  })
  await handleChatCompletions(chatRequest(body, otherKeyGen.key), deps())
  await waitFor(async () => (await postgresStore.query({ limit: 10 })).rows.length >= 2)

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(2)
  expect(page.rows.every((row) => row.status !== 429)).toBe(true)
})

test('a spent budget is rejected as insufficient_quota', async () => {
  // gpt-4o-mini is unpriced in this seed, so charge the budget directly by
  // giving the key a budget it has already exceeded.
  const { apiKey, key } = await seedGateway({ limits: { budgetTotalUsd: '0.000001' } })
  const store = getUsageStore()
  await store.apply([{ key: totalSpendKey(key.id), kind: 'float', by: 1 }])

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps())

  expect(res.status).toBe(429)
  expect((await res.json()).error.code).toBe('insufficient_quota')
})

test('a store outage fails open', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })
  const store = getUsageStore()
  store.apply = async () => { throw new Error('redis is down') }
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const first = await handleChatCompletions(chatRequest(body, apiKey), deps())
  const second = await handleChatCompletions(chatRequest(body, apiKey), deps())

  // Both served: the limit is not enforced while the store is down, which is
  // the deliberate trade. No headers, because no check happened.
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(second.headers.get('x-ratelimit-limit-requests')).toBeNull()
})

test('tokens are charged after the response completes', async () => {
  const { apiKey, key } = await seedGateway({ limits: { tpmLimit: 1000 } })
  await handleChatCompletions(chatRequest(body, apiKey), deps())

  const store = getUsageStore()
  const tpmKey = windowKey('tpm', key.id, bucketOf(Date.now()))
  await waitFor(async () => {
    const [tokens] = await store.apply([{ key: tpmKey, kind: 'int', by: 0 }])
    // 5 prompt + 2 completion, charged only once the response is complete.
    return tokens === 7
  })
})

test('the streaming path also carries rate limit headers and charges tokens', async () => {
  const { apiKey, key } = await seedGateway({ limits: { rpmLimit: 10, tpmLimit: 1000 } })
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  expect(res.headers.get('x-ratelimit-limit-requests')).toBe('10')
  // Drain the stream so the response's onDone callback fires and the log
  // write (where the charge lives) gets queued.
  await res.text()

  const store = getUsageStore()
  const tpmKey = windowKey('tpm', key.id, bucketOf(Date.now()))
  await waitFor(async () => {
    const [tokens] = await store.apply([{ key: tpmKey, kind: 'int', by: 0 }])
    // 5 prompt + 2 completion, charged only once the stream completes.
    return tokens === 7
  })
})

test('an upstream 429 is still written to the request log', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockRejectedValue(
    new OpenAI.APIError(429, { message: 'slow down', code: 'rate_limit_exceeded' }, 'slow down', undefined),
  )

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.status).toBe(429)

  await waitFor(async () => (await postgresStore.query({ limit: 10 })).rows.length >= 1)
  const [row] = (await postgresStore.query({ limit: 10 })).rows
  expect(row.status).toBe(429)
})
