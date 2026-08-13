import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type {
  ChatCompletionChunk, ProviderAdapter, ProviderRuntime,
} from '@/lib/adapters/types'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-responses-tool-call-stream.json'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function runtime(name: string): ProviderRuntime {
  return {
    id: name, name, adapter: 'openai', baseUrl: null,
    credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'responses',
  }
}

/** A real Responses adapter over a fake SDK client, so translation runs. */
function responsesAdapter(name: string, create: unknown): ProviderAdapter {
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return createResponsesAdapter(runtime(name), factory as never)
}

function responseResult(text: string) {
  return {
    id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5-mini',
    status: 'completed', incomplete_details: null,
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: {
      input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2,
    },
  }
}

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('a responses provider serves a plain chat completions request', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockResolvedValue(responseResult('from responses'))),
    }),
  )

  expect(res.status).toBe(200)
  const payload = await res.json()
  expect(payload.object).toBe('chat.completion')
  expect(payload.model).toBe('house-model')
  expect(payload.choices[0].message.content).toBe('from responses')
  expect(payload.usage.total_tokens).toBe(2)
})

test('a failing responses target fails over onto a chat completions target', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockRejectedValue(apiError(503, 'down'))),
      cc: { chat: vi.fn().mockResolvedValue(completion('cc')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect((await res.json()).choices[0].message.content).toBe('cc')
})

test('a failing chat completions target fails over onto a responses target', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'cc', priority: 0, apiFlavor: 'chat_completions' },
      { name: 'resp', priority: 1, apiFlavor: 'responses' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      cc: { chat: vi.fn().mockRejectedValue(apiError(429, 'slow down')) },
      resp: responsesAdapter('resp', vi.fn().mockResolvedValue(responseResult('rescued'))),
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('resp')
  expect((await res.json()).choices[0].message.content).toBe('rescued')
})

test('a responses provider streams through the SSE layer', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of fixture) yield event
    },
  }))

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({ resp: responsesAdapter('resp', create) }),
  )

  expect(res.status).toBe(200)
  const text = await res.text()
  expect(sseTerminated(text)).toBe(true)

  const chunks = parseSseChunks(text) as ChatCompletionChunk[]
  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  // Identity rewriting still applies: every chunk claims the virtual model.
  expect(chunks.every((c) => c.model === 'house-model')).toBe(true)
})

test('a responses stream that dies before its first chunk still fails over', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'cc-model',
      choices: [{ index: 0, delta: { content: 'from cc' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockRejectedValue(apiError(503, 'down'))),
      cc: { chatStream: working as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect(sseTerminated(await res.text())).toBe(true)
})
