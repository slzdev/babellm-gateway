import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAdapter, resolveProviderRuntime, withModelPaths } from '@/lib/adapters/registry'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { encryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import type { ProviderRuntime } from '@/lib/adapters/types'

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
 *
 * A fresh `Response` per call, not one shared instance: a transcribe request
 * carries a `File`, which routes the SDK through its multipart form path, and
 * that path probes `fetch` once with a throwaway request before it ever sends
 * the real one — see `supportsFormData` in the OpenAI SDK's upload internals.
 * A single shared `Response` would have its body consumed by that probe, and
 * the real call would then fail with "Body has already been read."
 */
function stubFetch() {
  const fetchSpy = vi.fn().mockImplementation(async () => new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function calledPath(fetchSpy: ReturnType<typeof stubFetch>): string {
  return String(fetchSpy.mock.calls[0][0])
}

/**
 * The last call rather than the first: a transcribe request's file routes
 * the SDK through its multipart form path, which probes `fetch` once with a
 * throwaway `data:,` request (see `stubFetch`'s comment) before it ever sends
 * the real one. Every other endpoint here makes exactly one call, so this is
 * equivalent to `calledPath` for them too — it just also works for transcribe.
 */
function lastCalledPath(fetchSpy: ReturnType<typeof stubFetch>): string {
  const calls = fetchSpy.mock.calls
  return String(calls[calls.length - 1][0])
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
  const adapter = createAdapter(provider({ apiFlavor: 'chat_completions' }), 'responses')
  await adapter.chat(chatBody, chatCtx)

  // The model's override arrives as an argument, so a model may reach the
  // Responses endpoint of a provider whose default is Chat Completions.
  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
})

test('a model path override moves the chat completions endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/api/chat')
})

test('a model path override moves the responses endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'responses',
    { responsesPath: '/api/v2/responses' },
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
    'chat_completions',
    { chatCompletionsPath: null, responsesPath: null },
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
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )
  await adapter.listModels!({ signal: new AbortController().signal })

  expect(calledPath(fetchSpy)).toBe('https://api.example/api/models')
})

test('gemini accepts model path overrides and ignores them', () => {
  // Gemini's client builds its own URLs, so the only thing worth pinning is
  // that a model carrying paths does not break its construction.
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'g-key' }) }),
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )

  expect(typeof adapter.chat).toBe('function')
})

test('an anthropic_messages model hits /messages, not /chat/completions or /responses', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'anthropic_messages',
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
    'anthropic_messages',
    { messagesPath: '/anthropic/v1/messages' },
  )
  await adapter.chat(chatBody, chatCtx)

  // The model's override arrives resolved against the base URL's origin, the
  // same rule chatCompletionsPath and responsesPath already follow — and it
  // must win over the provider's own messagesPath, not merely over the default.
  expect(calledPath(fetchSpy)).toBe('https://api.example/anthropic/v1/messages')
})

test('the gemini adapter ignores an anthropic_messages flavor, as it ignores the others', () => {
  const adapter = createAdapter(provider({ adapter: 'gemini' }), 'anthropic_messages')
  expect(typeof adapter.chat).toBe('function')
})

test('an openai_compatible provider with no base URL is still refused', () => {
  expect(() => createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: null }),
    'anthropic_messages',
  )).toThrow(/no base URL/)
})

function runtime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'p',
    adapter: 'openai',
    baseUrl: null,
    credentials: { apiKey: 'sk-test' },
    config: {},
    ...overrides,
  }
}

test('withModelPaths copies a set audioTranscriptionsPath onto the config', () => {
  const layered = withModelPaths(runtime(), { audioTranscriptionsPath: '/api/v2/audio' })
  expect(layered.config.audioTranscriptionsPath).toBe('/api/v2/audio')
})

test('withModelPaths leaves the provider\'s audioTranscriptionsPath standing when the model names none', () => {
  const layered = withModelPaths(
    runtime({ config: { audioTranscriptionsPath: '/provider/audio' } }),
    { audioTranscriptionsPath: null },
  )
  // null is "this model says nothing", which must not erase the provider's
  // value — the same rule the other three path keys already follow.
  expect(layered.config.audioTranscriptionsPath).toBe('/provider/audio')
})

test('withModelPaths is a no-op when only audioTranscriptionsPath is null alongside the rest', () => {
  const original = runtime({ config: { audioTranscriptionsPath: '/provider/audio' } })
  const layered = withModelPaths(original, {
    chatCompletionsPath: null, responsesPath: null, messagesPath: null, audioTranscriptionsPath: null,
  })
  expect(layered).toBe(original)
})

// transcribe: /audio/transcriptions is a sibling endpoint on the same host,
// not a dialect of chat (design doc §3.4), so both OpenAI-shaped flavors must
// reach it — and only the anthropic_messages flavor, whose host has no
// transcription endpoint at all, may not.

const transcribeCtx = {
  upstreamModel: 'whisper-upstream',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

function transcribeRequest() {
  return {
    file: new File([new Uint8Array(8)], 'clip.mp3', { type: 'audio/mpeg' }),
    model: 'whisper-1',
    response_format: 'json' as const,
  }
}

test('a chat_completions-flavored provider transcribes at /audio/transcriptions', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'chat_completions' }))
  await adapter.transcribe(transcribeRequest(), transcribeCtx)

  expect(lastCalledPath(fetchSpy)).toMatch(/\/audio\/transcriptions$/)
})

test('a responses-flavored provider transcribes at the same endpoint, not at /responses', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }))
  await adapter.transcribe(transcribeRequest(), transcribeCtx)

  expect(lastCalledPath(fetchSpy)).toMatch(/\/audio\/transcriptions$/)
})

test('a model path override moves the audio transcriptions endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'chat_completions',
    { audioTranscriptionsPath: '/api/v2/audio' },
  )
  await adapter.transcribe(transcribeRequest(), transcribeCtx)

  expect(lastCalledPath(fetchSpy)).toBe('https://api.example/api/v2/audio')
})

test('an anthropic_messages target cannot transcribe', async () => {
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'anthropic_messages',
  )

  await expect(adapter.transcribe(transcribeRequest(), transcribeCtx))
    .rejects.toThrow(UnsupportedOperationError)
})

test('gemini now serves a real translated transcription, not the withTranscribeUnsupported placeholder', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'g-key' }) }),
  )

  // Task 6 replaced the withTranscribeUnsupported wrapper with a real,
  // translated implementation (tests/lib/adapters/gemini/transcription.test.ts
  // covers its params, mapping and error handling in isolation). What
  // matters here is only that the registry wires it up: the call reaches
  // Gemini's generateContent endpoint at all, rather than throwing
  // UnsupportedOperationError before any upstream attempt. The stub returns
  // an empty body, so the translator's own "no transcription text" check
  // surfaces as a ProviderError — never the placeholder's error.
  const error = await adapter
    .transcribe(transcribeRequest(), transcribeCtx)
    .catch((err: unknown) => err)

  expect(error).not.toBeInstanceOf(UnsupportedOperationError)
  expect(fetchSpy).toHaveBeenCalled()
})
