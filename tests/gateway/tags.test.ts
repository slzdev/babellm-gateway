import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { handleResponses } from '@/lib/gateway/responses-handler'
import {
  chatRequest, fakeAdapterByProvider, fakeAdapterDeps, responsesRequest, seedGateway, seedTargets,
} from '../helpers/gateway'
import { waitForLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const upstreamResponse = {
  id: 'resp_upstream', object: 'response', created_at: 1, model: 'up-model',
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

test('a valid header lands on the log row', async () => {
  const { apiKey } = await seedGateway()

  const response = await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod,feature=checkout' }),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  expect(response.status).toBe(200)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod', feature: 'checkout' })
})

test('no header means a null tags column, not an empty object', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toBeNull()
})

test('a malformed header is a 400 that never reaches the provider', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const response = await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod,ENV=staging' }),
    fakeAdapterDeps({ chat }),
  )

  expect(response.status).toBe(400)
  const payload = await response.json()
  expect(payload.error.code).toBe('invalid_tags')
  expect(payload.error.message).toBe('x-babellm-tags: duplicate key "env"')
  expect(chat).not.toHaveBeenCalled()
})

// The rejection has to be attributable, which is the whole reason validation
// runs after resolveApiKey rather than before it.
test('a rejected header still writes a log row against the calling key', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'not a pair' }),
    fakeAdapterDeps({ chat: vi.fn() }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0]).toMatchObject({ status: 400, outcome: 'error', keyName: 'test key' })

  const detail = await postgresStore.get(page.rows[0].id)
  expect(detail?.errorCode).toBe('invalid_tags')
})

// Tags are most useful on requests that went wrong, so they must not be
// conditional on the request going right. This is what the ordering in the
// handler buys, and it is the test that would fail if someone moved the
// parse below the body parse or the routing.
test('tags reach the log row when the upstream call fails', async () => {
  const { apiKey } = await seedGateway()
  const boom = new OpenAI.APIError(500, { message: 'boom', code: 'x' }, 'boom', undefined)

  await handleChatCompletions(
    chatRequest(body, apiKey, { 'x-babellm-tags': 'env=prod' }),
    fakeAdapterDeps({ chat: vi.fn().mockRejectedValue(boom) }),
  )
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].status).toBeGreaterThanOrEqual(500)
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

test('tags reach the log row when the body fails to parse', async () => {
  const { apiKey } = await seedGateway()

  const response = await handleChatCompletions(
    chatRequest({ messages: [] }, apiKey, { 'x-babellm-tags': 'env=prod' }),
    fakeAdapterDeps({ chat: vi.fn() }),
  )
  expect(response.status).toBe(400)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

// Both ingresses run through runGatewayRequest, so the header is read once
// for both. This is the test that fails if someone moves the parse into the
// chat ingress instead of the shared lifecycle.
test('the responses ingress reads the same header', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi' },
      apiKey,
      { 'x-babellm-tags': 'env=prod' },
    ),
    fakeAdapterByProvider({
      p1: { respond: vi.fn().mockResolvedValue(upstreamResponse) },
    }),
  )

  expect(res.status).toBe(200)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].tags).toEqual({ env: 'prod' })
})

test('the responses ingress rejects a malformed header too', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi' },
      apiKey,
      { 'x-babellm-tags': 'env=prod,ENV=staging' },
    ),
    fakeAdapterByProvider({ p1: { respond: vi.fn() } }),
  )

  expect(res.status).toBe(400)
  const payload = await res.json()
  expect(payload.error.code).toBe('invalid_tags')
})
