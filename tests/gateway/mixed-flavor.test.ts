import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import { withRespondViaChat } from '@/lib/adapters/wrappers'
import type {
  ChatCompletion, ChatCompletionChunk, ProviderAdapter, ProviderRuntime,
} from '@/lib/adapters/types'
import {
  chatRequest, fakeAdapterByProvider, responsesRequest, seedTargets,
} from '../helpers/gateway'
import { parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-responses-tool-call-stream.json'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function runtime(name: string): ProviderRuntime {
  return {
    id: name, name, adapter: 'openai', baseUrl: null,
    credentials: { apiKey: 'sk-test' }, config: {},
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

/**
 * A Responses-shaped result, for a fake `respond` on a Responses-native
 * target. Unused by the tests below as things stand — "a chat request still
 * reaches a responses-flavored target" pins ingress dispatch instead (see its
 * comment) — but kept, mirroring `completion()`, for the next test that needs
 * one.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function responsesResult(from: string) {
  return {
    id: 'resp_1', object: 'response', created_at: 1, model: `${from}-model`,
    status: 'completed', incomplete_details: null,
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: from, annotations: [] }],
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

/**
 * A chat-only adapter (as the registry constructs one for a chat_completions
 * target, before wrapping), wrapped through the same `withRespondViaChat` the
 * registry applies — so a mixed-flavor test can exercise the real crossing
 * path without going through `createAdapter` itself.
 */
function chatOnlyRespondingVia(
  providerName: string,
  chat: (req: unknown, ctx: unknown) => Promise<ChatCompletion>,
): ProviderAdapter {
  return withRespondViaChat(
    {
      chat: chat as ProviderAdapter['chat'],
      async *chatStream(): AsyncIterable<never> {
        throw new Error(`chatStream not used in this test for ${providerName}`)
      },
    },
    providerName,
  )
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

test('a Responses request is served by a chat-only target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1' }] })
  const chat = vi.fn().mockResolvedValue(completion('p1'))

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    // Bypassing `createAdapter` means the registry's wrapping never runs on
    // this fake — apply it explicitly so the test exercises the same crossing
    // path a real chat-only target goes through.
    fakeAdapterByProvider({ p1: chatOnlyRespondingVia('p1', chat) }),
  )

  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.object).toBe('response')
  expect(body.output[0].content[0].text).toBe('p1')
  // The chat adapter saw a Chat Completions request, never a Responses one.
  expect(chat.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'user', content: 'hi' }] })
})

test('a Responses request reaches a gemini target through the same wrapper', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', truncation: 'auto' }, apiKey),
    fakeAdapterByProvider({
      gem: chatOnlyRespondingVia('gem', vi.fn().mockResolvedValue(completion('gem'))),
    }),
  )

  expect(res.status).toBe(200)
  // Two translation stages, one list: what Responses-to-Chat dropped and what
  // Gemini cannot express are reported together.
  expect(res.headers.get('x-babellm-dropped-params')).toContain('truncation')
})

test('a hosted tool against a chat-only target is a 400 that does not fail over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'p1' }, { name: 'p2', apiFlavor: 'responses' }],
  })
  const respond = vi.fn()

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', tools: [{ type: 'web_search' }] }, apiKey),
    fakeAdapterByProvider({
      p1: chatOnlyRespondingVia('p1', vi.fn()),
      p2: { respond },
    }),
  )

  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.error.message).toContain('web_search')
  // Non-retryable: the chain stops rather than replaying against p2. This is the
  // documented limitation in section 9 of the spec, asserted so it stays a
  // decision rather than becoming an accident.
  expect(respond).not.toHaveBeenCalled()
})

test('a chat request still reaches a responses-flavored target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleChatCompletions(
    chatRequest({ model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }, apiKey),
    // A real responses-flavored adapter (createResponsesAdapter) implements
    // `chat` natively via chat-to-responses.ts — `withChatViaResponses` is
    // identity and has nothing to add here. That translation is covered at
    // the adapter level (responses-chat.test.ts) and registry dispatch by
    // flavor at tests/lib/adapters/registry.test.ts; this only pins that the
    // chat ingress always calls `adapter.chat`, never `adapter.respond`,
    // regardless of the target's flavor.
    fakeAdapterByProvider({ p1: { chat: vi.fn().mockResolvedValue(completion('p1')) } }),
  )

  expect(res.status).toBe(200)
  expect((await res.json()).object).toBe('chat.completion')
})
