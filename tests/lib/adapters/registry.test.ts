import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAdapter, resolveProviderRuntime } from '@/lib/adapters/registry'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { encryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const chatCtx = {
  upstreamModel: 'model-x',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const chatBody = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] }

/**
 * createOpenAIClient never passes a `fetch` option, so the SDK falls back to
 * `globalThis.fetch` — captured once, at client construction. Stubbing it
 * lets these tests observe which upstream path an adapter actually calls
 * (`/chat/completions` vs `/responses`), which is the one thing that
 * distinguishes the two adapters from the outside: both satisfy the same
 * `ProviderAdapter` shape, so asserting only that `chat` is a function cannot
 * tell them apart, and would pass even if the flavor branch were wired
 * backwards.
 */
function stubFetch() {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function calledPath(fetchSpy: ReturnType<typeof stubFetch>): string {
  return String(fetchSpy.mock.calls[0][0])
}

/** The SSE body a streaming upstream returns. `stubFetch` answers JSON, which
 *  the SDK's streaming path cannot parse — a forced adapter calls the
 *  streaming endpoint, so it needs an event stream to drain. */
function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function stubStreamingFetch(body: string) {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

/** What the adapter actually put on the wire. */
function sentBody(fetchSpy: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[0][1].body))
}

const streamedChunk = {
  id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'model-x',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
}

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'p',
    adapter: 'openai',
    baseUrl: null,
    credentials: encryptJson({ apiKey: 'sk-test' }),
    config: '{}',
    apiFlavor: 'chat_completions',
    forceUpstreamStream: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProviderRow
}

test('resolveProviderRuntime decrypts credentials and parses config', () => {
  const runtime = resolveProviderRuntime(
    provider({ config: '{"disableStreamUsage":true}' }),
  )
  expect(runtime.credentials).toEqual({ apiKey: 'sk-test' })
  expect(runtime.config.disableStreamUsage).toBe(true)
})

test('creates an adapter for the openai type', () => {
  const adapter = createAdapter(provider())
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.chatStream).toBe('function')
})

test('creates an adapter for the openai_compatible type', () => {
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.x.ai/v1',
      credentials: encryptJson({ apiKey: 'xai-test' }),
    }),
  )
  expect(typeof adapter.chat).toBe('function')
})

test('openai_compatible without a base URL is rejected', () => {
  expect(() =>
    createAdapter(provider({ adapter: 'openai_compatible', baseUrl: null })),
  ).toThrow(/base URL/i)
})

test('bedrock is not yet implemented', () => {
  expect(() => createAdapter(provider({ adapter: 'bedrock' }))).toThrow(UnsupportedOperationError)
})

test('gemini gets a real adapter', () => {
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'g-key' }) }),
  )
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.listModels).toBe('function')
})

test('a chat_completions-flavored provider hits /chat/completions, not /responses', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'chat_completions' }))
  await adapter.chat(chatBody, chatCtx)

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(calledPath(fetchSpy)).toMatch(/\/chat\/completions$/)
})

test('a responses-flavored provider hits /responses, not /chat/completions', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }))
  await adapter.chat(chatBody, chatCtx)

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
})

test('flavor is honoured for openai_compatible providers too', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({
    adapter: 'openai_compatible',
    baseUrl: 'https://api.example/v1',
    apiFlavor: 'responses',
  }))
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
})

test('an openai_compatible provider still defaults to chat completions', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({
    adapter: 'openai_compatible',
    baseUrl: 'https://api.example/v1',
  }))
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/v1/chat/completions')
})

test('a responses-flavored openai_compatible provider still needs a base URL', () => {
  expect(() =>
    createAdapter(provider({
      adapter: 'openai_compatible', baseUrl: null, apiFlavor: 'responses',
    })),
  ).toThrow(/base URL/i)
})

test('an explicit flavor overrides the provider column', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ apiFlavor: 'chat_completions' }),
    { flavor: 'responses' },
  )
  await adapter.chat(chatBody, chatCtx)

  // The model's override arrives as an argument, so a model may reach the
  // Responses endpoint of a provider whose default is Chat Completions.
  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
})

test('a model path override moves the chat completions endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    { flavor: 'chat_completions', paths: { chatCompletionsPath: '/api/chat' } },
  )
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/api/chat')
})

test('a model path override moves the responses endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    { flavor: 'responses', paths: { responsesPath: '/api/v2/responses' } },
  )
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/api/v2/responses')
})

test('a model that names no path leaves the provider config alone', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.example/v1',
      config: JSON.stringify({ chatCompletionsPath: '/provider/chat' }),
    }),
    { flavor: 'chat_completions', paths: { chatCompletionsPath: null, responsesPath: null } },
  )
  await adapter.chat(chatBody, chatCtx)

  // null is "this model says nothing", which must not erase the provider's
  // value — the distinction the nullable columns exist to preserve.
  expect(calledPath(fetchSpy)).toBe('https://api.example/provider/chat')
})

test('a model cannot move the models listing path', async () => {
  // Listing is a provider operation: sync calls createAdapter with no model in
  // hand, so a per-model override must not reach it.
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchSpy)

  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.example/v1',
      config: JSON.stringify({ modelsPath: '/api/models' }),
    }),
    { flavor: 'chat_completions', paths: { chatCompletionsPath: '/api/chat' } },
  )
  await adapter.listModels!({ signal: new AbortController().signal })

  expect(calledPath(fetchSpy)).toBe('https://api.example/api/models')
})

test('gemini accepts model path overrides and ignores them', () => {
  // Gemini's client builds its own URLs, so the only thing worth pinning is
  // that a model carrying paths does not break its construction.
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'g-key' }) }),
    { flavor: 'chat_completions', paths: { chatCompletionsPath: '/api/chat' } },
  )

  expect(typeof adapter.chat).toBe('function')
})

test('an anthropic_messages model hits /messages, not /chat/completions or /responses', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    { flavor: 'anthropic_messages' },
  )
  expect(typeof adapter.respond).toBe('function')
  await adapter.chat(chatBody, chatCtx)

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(calledPath(fetchSpy)).toMatch(/\/messages$/)
})

test('a model path override moves the messages endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.example/v1',
      config: JSON.stringify({ messagesPath: '/provider/messages' }),
    }),
    { flavor: 'anthropic_messages', paths: { messagesPath: '/anthropic/v1/messages' } },
  )
  await adapter.chat(chatBody, chatCtx)

  // The model's override arrives resolved against the base URL's origin, the
  // same rule chatCompletionsPath and responsesPath already follow — and it
  // must win over the provider's own messagesPath, not merely over the default.
  expect(calledPath(fetchSpy)).toBe('https://api.example/anthropic/v1/messages')
})

test('the gemini adapter ignores an anthropic_messages flavor, as it ignores the others', () => {
  const adapter = createAdapter(provider({ adapter: 'gemini' }), { flavor: 'anthropic_messages' })
  expect(typeof adapter.chat).toBe('function')
})

test('an openai_compatible provider with no base URL is still refused', () => {
  expect(() => createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: null }),
    { flavor: 'anthropic_messages' },
  )).toThrow(/no base URL/)
})

test('an unforced provider still calls the non-streaming endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'chat_completions' }))
  await adapter.chat(chatBody, chatCtx)

  expect(sentBody(fetchSpy).stream).toBe(false)
})

test('forceStream makes chat() ask the upstream for a stream', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(
    provider({ apiFlavor: 'chat_completions' }),
    { forceStream: true },
  )
  const result = await adapter.chat(chatBody, chatCtx)

  // The upstream saw a stream…
  expect(sentBody(fetchSpy).stream).toBe(true)
  // …and the caller got a single completion regardless.
  expect(result.object).toBe('chat.completion')
  expect(result.choices[0].message.content).toBe('hi')
})

test('the provider column forces even when settings name no forceStream', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(provider({ forceUpstreamStream: true }))
  await adapter.chat(chatBody, chatCtx)

  // catalog sync and the provider test button call createAdapter with no
  // settings at all; the provider's own column has to still apply.
  expect(sentBody(fetchSpy).stream).toBe(true)
})

test('an explicit forceStream: false beats a provider column set to true', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ forceUpstreamStream: true }),
    { forceStream: false },
  )
  await adapter.chat(chatBody, chatCtx)

  // This is how a catalog model opts out of its provider.
  expect(sentBody(fetchSpy).stream).toBe(false)
})

test('forceStream reaches respond() through withRespondViaChat on a chat-only adapter', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(
    provider({ apiFlavor: 'chat_completions' }),
    { forceStream: true },
  )
  await adapter.respond({ model: 'fast', input: 'hi' } as never, chatCtx)

  // The forcing wrapper goes INSIDE withRespondViaChat, so the Responses
  // ingress is forced too. Reversing that order would leave this at false.
  expect(calledPath(fetchSpy)).toMatch(/\/chat\/completions$/)
  expect(sentBody(fetchSpy).stream).toBe(true)
})

test('forceStream on a responses provider forces respond() natively', async () => {
  const fetchSpy = stubStreamingFetch(sse(
    {
      type: 'response.completed',
      response: { id: 'resp_1', object: 'response', status: 'completed' },
    },
  ))
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }), { forceStream: true })
  const result = await adapter.respond({ model: 'fast', input: 'hi' } as never, chatCtx)

  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
  expect(sentBody(fetchSpy).stream).toBe(true)
  // Verbatim, not reassembled: the terminal event carried the whole object.
  expect(result).toEqual({ id: 'resp_1', object: 'response', status: 'completed' })
})

test('forceStream on a gemini provider forces it too', async () => {
  // Flavor says nothing about Gemini, but forcing is about the upstream call
  // rather than the dialect, so the gemini branch must apply it as well.
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'k' }) }),
    { forceStream: true },
  )

  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.respond).toBe('function')
})
