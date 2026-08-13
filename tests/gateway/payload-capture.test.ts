import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { setLoggingSettings } from '@/lib/settings'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { waitForLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
})

async function seedWithCapture(logPayloads: boolean) {
  const seeded = await seedGateway()
  await db.update(apiKeys).set({ logPayloads }).where(eq(apiKeys.id, seeded.key.id))
  return seeded
}

test('a key with payload logging off stores no payload', async () => {
  const { apiKey } = await seedWithCapture(false)

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(false)
  expect((await postgresStore.get(row.requestId))?.payload).toBeNull()
})

test('a key with payload logging on stores what the client sent and received', async () => {
  const { apiKey } = await seedWithCapture(true)

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(true)

  const detail = await postgresStore.get(row.requestId)
  expect(detail?.payload?.request).toMatchObject({ model: 'house-model' })
  // The rewritten completion — what the client actually received — not the
  // upstream one.
  const response = detail?.payload?.response as { model: string; choices: unknown[] }
  expect(response.model).toBe('house-model')
  expect(response.choices).toHaveLength(1)
})

test('a streaming response is assembled from its deltas', async () => {
  const { apiKey } = await seedWithCapture(true)
  const chatStream = async function* () {
    for (const content of ['Hel', 'lo ', 'world']) {
      yield {
        id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.requestId)
  const response = detail?.payload?.response as {
    choices: Array<{ message: { content: string } }>
  }
  expect(response.choices[0].message.content).toBe('Hello world')
})

test('an oversized payload is replaced by the truncation envelope', async () => {
  const { apiKey } = await seedWithCapture(true)
  await setLoggingSettings({ payloadMaxBytes: 64 })
  clearRequestLogStoreCache()

  const long = { ...body, messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  await handleChatCompletions(
    chatRequest(long, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.requestId)
  expect(detail?.payload?.truncated).toBe(true)
  expect(detail?.payload?.request).toMatchObject({ truncated: true })
})

test('a request that fails before parsing records no payload', async () => {
  await seedWithCapture(true)

  const malformed = new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  await handleChatCompletions(malformed, fakeAdapterDeps({}))
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(false)
})
