import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import { createAnthropicAdapter } from '@/lib/adapters/anthropic'
import { withRespondViaChat, withTranscribeUnsupported } from '@/lib/adapters/wrappers'
import type {
  ChatCompletion, ChatCompletionChunk, ChatOnlyAdapter, ProviderAdapter, ProviderRuntime,
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

/** A real Anthropic adapter over a fake SDK client, wrapped exactly as the
 *  registry wraps it, so both ingresses exercise the real crossings. */
function anthropicAdapter(name: string, create: unknown): ProviderAdapter {
  const factory = vi.fn().mockReturnValue({ messages: { create } })
  return withTranscribeUnsupported(
    withRespondViaChat(
      createAnthropicAdapter(
        { ...runtime(name), baseUrl: 'https://api.anthropic.com/v1' },
        null,
        factory as never,
      ),
      name,
    ),
    name,
    'the Anthropic Messages API has no transcription endpoint and no audio input at all',
  )
}

function anthropicMessage(text: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
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
  const chatOnly: ChatOnlyAdapter = {
    chat: chat as ProviderAdapter['chat'],
    async *chatStream(): AsyncIterable<never> {
      throw new Error(`chatStream not used in this test for ${providerName}`)
    },
  }
  const respondable = withRespondViaChat(chatOnly, providerName)
  return withTranscribeUnsupported(
    respondable,
    providerName,
    'this test fixture has no transcription implementation',
  )
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

/**
 * A chat-only adapter whose `chatStream` is under test control, rather than
 * hard-failing if called — the counterpart to `chatOnlyRespondingVia` above,
 * which only ever exercises `respond` (via `chat`).
 */
function chatOnlyStreamingVia(
  providerName: string,
  chatStream: () => AsyncIterable<ChatCompletionChunk>,
): ProviderAdapter {
  const chatOnly: ChatOnlyAdapter = {
    async chat(): Promise<ChatCompletion> {
      throw new Error(`chat not used in this test for ${providerName}`)
    },
    chatStream: chatStream as ProviderAdapter['chatStream'],
  }
  const respondable = withRespondViaChat(chatOnly, providerName)
  return withTranscribeUnsupported(
    respondable,
    providerName,
    'this test fixture has no transcription implementation',
  )
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

test('a Responses stream over a chat-only target fails over on a dead first chunk', async () => {
  // Regression test: `fromCompletionStream` used to yield `response.created`
  // before ever pulling from the upstream chat stream, so `startStream`
  // resolved — and the HTTP response committed — without the provider having
  // been contacted at all. A dead first target could not fail over; the
  // client got a 200 followed by a mid-stream error instead of a rescue by
  // the second target, exactly as the same-shaped chat-ingress test above
  // (line 180) already pins for the other diagonal.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'cc', priority: 0 },
      { name: 'cc2', priority: 1 },
    ],
  })

  const dying = async function* (): AsyncIterable<ChatCompletionChunk> {
    throw apiError(503, 'down')
  }
  const rescued = async function* (): AsyncIterable<ChatCompletionChunk> {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'cc2-model',
      choices: [{ index: 0, delta: { content: 'rescued' }, finish_reason: 'stop' }],
    } as ChatCompletionChunk
  }

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', stream: true }, apiKey),
    fakeAdapterByProvider({
      cc: chatOnlyStreamingVia('cc', dying),
      cc2: chatOnlyStreamingVia('cc2', rescued),
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('cc2')
  const text = await res.text()
  expect(text).toContain('event: response.created')
  expect(text).toContain('event: response.completed')
  expect(text).toContain('rescued')
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
    responsesRequest(
      // `truncation: 'auto'` trips responses-to-chat's own drop;
      // `parallel_tool_calls: false` survives that translation into the Chat
      // request (toChatRequest maps it straight through) and only then trips
      // Gemini's UNMAPPABLE list — a real instruction Gemini cannot honour,
      // not the `true` default chat-to-gemini treats as inert. Together they
      // pin that `droppedFor` composes both stages' lists rather than one
      // shadowing the other.
      { model: 'house-model', input: 'hi', truncation: 'auto', parallel_tool_calls: false },
      apiKey,
    ),
    fakeAdapterByProvider({
      gem: chatOnlyRespondingVia('gem', vi.fn().mockResolvedValue(completion('gem'))),
    }),
  )

  expect(res.status).toBe(200)
  // Two translation stages, one list: what Responses-to-Chat dropped and what
  // Gemini cannot express are reported together. Deleting the Gemini
  // composition stage would still leave `truncation` (from responses-to-chat
  // alone), so `parallel_tool_calls` is the assertion that actually depends
  // on it.
  const dropped = res.headers.get('x-babellm-dropped-params')
  expect(dropped).toContain('truncation')
  expect(dropped).toContain('parallel_tool_calls')
})

test('a gemini target pinned to responses flavor still reports what Gemini drops', async () => {
  // Regression test: droppedFor used to check the flavor short-circuit before
  // the Gemini branch, so a candidate whose model pins api_flavor: 'responses'
  // reported nothing here, even though the Gemini adapter translates and drops
  // regardless of flavor (see the reordering above, mirroring chatIngress).
  const { apiKey } = await seedTargets({
    targets: [{ name: 'gem', adapter: 'gemini', apiFlavor: 'responses' }],
  })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi', parallel_tool_calls: false },
      apiKey,
    ),
    fakeAdapterByProvider({
      gem: chatOnlyRespondingVia('gem', vi.fn().mockResolvedValue(completion('gem'))),
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')).toBe('parallel_tool_calls')
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
    // `chat` natively via chat-to-responses.ts — the registry returns it
    // unwrapped and has nothing to add here. That translation is covered at
    // the adapter level (responses-chat.test.ts) and registry dispatch by
    // flavor at tests/lib/adapters/registry.test.ts; this only pins that the
    // chat ingress always calls `adapter.chat`, never `adapter.respond`,
    // regardless of the target's flavor.
    fakeAdapterByProvider({ p1: { chat: vi.fn().mockResolvedValue(completion('p1')) } }),
  )

  expect(res.status).toBe(200)
  expect((await res.json()).object).toBe('chat.completion')
})

test('a Chat Completions client is served by an anthropic_messages model', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  const create = vi.fn().mockResolvedValue(anthropicMessage('from anthropic'))
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(res.status).toBe(200)
  await expect(res.json()).resolves.toMatchObject({
    choices: [{ message: { content: 'from anthropic' } }],
  })
  // The upstream saw a Messages request, not a Chat Completions one.
  expect(create.mock.calls[0][0].messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ])
})

test('a Responses client reaches the same model through the double crossing', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  const create = vi.fn().mockResolvedValue(anthropicMessage('crossed twice'))
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    deps,
  )

  expect(res.status).toBe(200)
  await expect(res.json()).resolves.toMatchObject({
    status: 'completed',
    output: [{ content: [{ text: 'crossed twice' }] }],
  })
})

test("the model's thinking reaches a Responses client as a reasoning summary", async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  async function* events() {
    yield {
      type: 'message_start',
      message: {
        id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 0 },
      },
    }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } }
    yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }
  }
  const create = vi.fn().mockResolvedValue(events())
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi', stream: true, reasoning: { effort: 'high' } },
      apiKey,
    ),
    deps,
  )

  const text = await res.text()
  const chunks = parseSseChunks(text)
  const types = chunks.map((c) => (c as { type?: string }).type)
  expect(types).toContain('response.reasoning_summary_text.delta')
  expect(types).toContain('response.output_text.delta')
  // The thinking the client asked for was actually requested upstream.
  expect(create.mock.calls[0][0].thinking).toEqual({ type: 'adaptive', display: 'summarized' })
})

test('failover crosses flavors: an anthropic target fails, a chat target serves', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages', priority: 1 },
      { name: 'openai-fallback', apiFlavor: 'chat_completions', priority: 2 },
    ],
  })
  const create = vi.fn().mockRejectedValue(apiError(503, 'overloaded'))
  const deps = fakeAdapterByProvider({
    claude: anthropicAdapter('claude', create),
    'openai-fallback': { chat: async () => completion('openai-fallback') as never },
  })

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('openai-fallback')
})
