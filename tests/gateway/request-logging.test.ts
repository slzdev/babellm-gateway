import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import * as logs from '@/lib/logs'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import * as pricing from '@/lib/pricing'
import { clearPriceCache } from '@/lib/pricing'
import { db } from '@/lib/db'
import { catalogModels } from '@/lib/db/schema'
import {
  chatRequest, fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedPrices, seedTargets,
} from '../helpers/gateway'
import { waitFor, waitForLogs } from '../helpers/logs'
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

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
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
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({
    model: 'house-model', keyName: 'test key', status: 200, outcome: 'ok',
    finalProvider: 'test-provider', finalUpstreamModel: 'gpt-4o-mini',
    promptTokens: 1_000_000, completionTokens: 1_000_000,
  })

  const detail = await postgresStore.get(page.rows[0].id)
  expect(detail?.finalTargetId).toBe(target.id)
  expect(detail?.attempts[0]).toMatchObject({ provider: 'test-provider', status: 200 })
})

test('the row records every attempt made, in order', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { chat: vi.fn().mockResolvedValue(upstreamCompletion) },
    }),
  )
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.id)
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0]).toMatchObject({ n: 1, provider: 'primary', status: 503 })
  expect(detail?.attempts[1]).toMatchObject({ n: 2, provider: 'backup', status: 200 })
})

test('a request that exhausted every target still logs its attempts', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(500)) },
      b: { chat: vi.fn().mockRejectedValue(apiError(429)) },
    }),
  )
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 429, outcome: 'error' })
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(2)
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
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBeCloseTo(4, 6)
})

test('an unpriced model logs a null cost rather than zero', async () => {
  const { apiKey } = await seedGateway()

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  expect((await postgresStore.query({ limit: 1 })).rows[0].costUsd).toBeNull()
})

test('the logged cost is the same number the client was given', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  const clientTotal = (await res.json()).usage.cost.total_usd
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBe(Number(clientTotal))
})

test('the log keeps the catalog rates the client never sees', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  // The regression this guards: narrowing StreamCapture.cost or LogExtra.cost
  // to the client's CostPayload would strip `pricing` out of every row.
  // Note LogDetail exposes `pricing` at the top level, not under `cost` —
  // see the read path in src/lib/logs/postgres.ts.
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.id)
  expect(detail?.pricing).toMatchObject({
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
})

test('a streamed request logs the cost its final chunk carried', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  async function* chatStream() {
    yield {
      id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
    yield {
      id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4o-mini', choices: [],
      usage: {
        prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBeCloseTo(4, 6)
})

test('the catalog is queried once per request, not once for the client and once for the log', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
  const priceFor = vi.spyOn(pricing, 'priceFor')

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  expect(priceFor).toHaveBeenCalledTimes(1)
})

test('a rejected request logs the error without a key or attempts', async () => {
  await seedGateway()

  await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 401, outcome: 'error', keyName: null })

  const detail = await postgresStore.get(row.id)
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
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ stream: true, outcome: 'ok', promptTokens: 7, completionTokens: 2 })
  expect(row.ttftMs).not.toBeNull()
})

test('a streaming request logs nothing until the stream closes, then once', async () => {
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
  // The response headers are out, but the request is not over: a row here
  // would be a latency and an outcome measured before either was known.
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)

  await res.text()
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ stream: true, status: 200, outcome: 'ok' })
  expect(page.rows[0].ttftMs).not.toBeNull()
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
  await waitForLogs()

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
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ status: 200, outcome: 'stream_interrupted' })

  // The error that killed the stream must be carried into the row, not left
  // null next to an outcome that otherwise gives no reason.
  const detail = await postgresStore.get(page.rows[0].id)
  expect(detail?.errorType).not.toBeNull()
  expect(detail?.errorMessage).toContain('connection reset')
})

test('a write failure never reaches the client', async () => {
  const { apiKey } = await seedGateway()
  const failure = vi.spyOn(postgresStore, 'write').mockRejectedValue(new Error('disk full'))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  // No row will ever land for this request, so wait on the side effect that
  // does happen rather than on waitForLogs, which would just time out.
  await waitFor(() => stderr.mock.calls.length > 0)

  expect(res.status).toBe(200)
  expect(stderr).toHaveBeenCalled()
  failure.mockRestore()
  stderr.mockRestore()
})

test('a pricing failure costs the breakdown, not the request or its log row', async () => {
  const { apiKey } = await seedGateway()
  const failure = vi.spyOn(pricing, 'priceFor').mockRejectedValue(new Error('catalog unreachable'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  // The catalog is no longer in writeLog's path, so a rejection there costs
  // the cost breakdown and nothing else: the client is served, and the row
  // still lands — with a null cost, exactly like an unpriced model.
  expect(res.status).toBe(200)
  expect((await res.json()).usage.cost).toBeNull()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.costUsd).toBeNull()
  failure.mockRestore()
})

test('a throw inside writeLog never reaches the client', async () => {
  const { apiKey } = await seedGateway()
  // What the old pricing-failure test really guarded: the fire-and-forget
  // .catch() at the log() call site catches a rejection from an await inside
  // async writeLog, not merely one from logRequest. priceFor used to be that
  // await; resolveRequestLogStore is the one that remains.
  const failure = vi
    .spyOn(logs, 'resolveRequestLogStore')
    .mockRejectedValue(new Error('settings unreadable'))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  // No row can land, so wait on the side effect that does happen.
  await waitFor(() => stderr.mock.calls.length > 0)

  expect(res.status).toBe(200)
  expect(stderr).toHaveBeenCalled()
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)
  failure.mockRestore()
  stderr.mockRestore()
})

test('a client disconnect mid-stream logs client_closed exactly once', async () => {
  const { apiKey } = await seedGateway()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })

  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
    }
    await gate
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )

  const reader = res.body!.getReader()
  await reader.read()
  await reader.cancel()
  // Only now does the generator resume and run to completion, which is the
  // path that would settle a second time if the first-one-wins guard were
  // not there.
  release()
  await waitForLogs()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]).toMatchObject({ outcome: 'client_closed' })
})

test('a client disconnect on the non-streaming path logs client_closed, not an upstream timeout', async () => {
  const { apiKey } = await seedGateway()
  const controller = new AbortController()
  const request = new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  // Simulates what a real adapter sees once the client leaves mid-request:
  // its own fetch aborts because ctx.signal is AbortSignal.any([clientSignal, ...]).
  const chat = vi.fn().mockImplementation(async () => {
    controller.abort()
    throw new DOMException('The operation was aborted.', 'AbortError')
  })

  await handleChatCompletions(request, fakeAdapterDeps({ chat }))
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ outcome: 'client_closed' })
})
