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

test('a stream clipped mid-flight is marked truncated without a stored-payload envelope', async () => {
  // payload.truncated has three sources: an oversized *stored* request, an
  // oversized *stored* response (both via capPayload, which stamps a
  // {truncated: true, ...} envelope on the value), and a streaming
  // response whose assistant text hit the byte cap mid-relay
  // (sse.ts's `accumulate`, surfaced as chat-handler.ts's
  // `truncatedUpstream`). The third source stores an ordinary,
  // envelope-free completion object — this is the shape the detail page's
  // per-field truncation notice cannot explain on its own, and the
  // regression this test guards against.
  const { apiKey } = await seedWithCapture(true)
  await setLoggingSettings({ payloadMaxBytes: 1000 })
  clearRequestLogStoreCache()

  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    }
    // Far larger than the remaining budget, so the accumulator stops and
    // marks the capture truncated. The assembled text stays tiny, so the
    // final stored response JSON never itself crosses the cap.
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'x'.repeat(20_000) }, finish_reason: null }],
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

  expect(detail?.payload?.truncated).toBe(true)

  const response = detail?.payload?.response as Record<string, unknown>
  expect(response.object).toBe('chat.completion')
  expect(response).not.toHaveProperty('error')
  expect(response).not.toHaveProperty('preview')

  const request = detail?.payload?.request as Record<string, unknown>
  expect(request).not.toHaveProperty('preview')
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
