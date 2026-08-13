import { beforeEach, expect, test, vi } from 'vitest'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { db } from '@/lib/db'
import { catalogModels } from '@/lib/db/schema'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { flushLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 0 },
  },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

test('a successful request lands one row with its winning target', async () => {
  const { apiKey, target } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({
    model: 'house-model', keyName: 'test key', status: 200, outcome: 'ok',
    finalProvider: 'test-provider', finalUpstreamModel: 'gpt-4o-mini',
    promptTokens: 1_000_000, completionTokens: 1_000_000,
  })

  const detail = await postgresStore.get(page.rows[0].requestId)
  expect(detail?.finalTargetId).toBe(target.id)
  expect(detail?.attempts[0]).toMatchObject({ provider: 'test-provider', status: 200 })
})

test('cost is filled in when the catalog prices the winning model', async () => {
  const { apiKey, provider } = await seedGateway()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBeCloseTo(4, 6)
})

test('an unpriced model logs a null cost rather than zero', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  expect((await postgresStore.query({ limit: 1 })).rows[0].costUsd).toBeNull()
})

test('a rejected request logs the error without a key or attempts', async () => {
  await seedGateway()

  await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 401, outcome: 'error', keyName: null })

  const detail = await postgresStore.get(row.requestId)
  expect(detail?.attempts).toEqual([])
  expect(detail?.errorCode).toBe('missing_api_key')
})

test('a streaming request logs usage captured from the final chunk', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ stream: true, outcome: 'ok', promptTokens: 7, completionTokens: 2 })
  expect(row.ttftMs).not.toBeNull()
})

test('a provider that reports no stream usage logs nulls, not zeros', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.promptTokens).toBeNull()
  expect(row.completionTokens).toBeNull()
})

test('a mid-stream failure is logged as stream_interrupted despite the 200', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    }
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await flushLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ status: 200, outcome: 'stream_interrupted' })
})

test('a write failure never reaches the client', async () => {
  const { apiKey } = await seedGateway()
  const failure = vi.spyOn(postgresStore, 'write').mockRejectedValue(new Error('disk full'))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await flushLogs()

  expect(res.status).toBe(200)
  expect(stderr).toHaveBeenCalled()
  failure.mockRestore()
  stderr.mockRestore()
})
