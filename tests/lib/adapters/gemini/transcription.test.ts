import { expect, test, vi } from 'vitest'
import { ApiError } from '@google/genai'
import { createGeminiAdapter } from '@/lib/adapters/gemini'
import type { AttemptContext, ProviderRuntime } from '@/lib/adapters/types'
import { GatewayError, ProviderError } from '@/lib/gateway/errors'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'gemini-prod',
  adapter: 'gemini',
  baseUrl: null,
  credentials: { apiKey: 'g-key' },
  config: {},
}

const ctx: AttemptContext = {
  upstreamModel: 'gemini-2.5-flash',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const answer = {
  candidates: [{ content: { parts: [{ text: 'hello world' }] }, finishReason: 'STOP' }],
}

function audioFile(bytes = 8, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

function request(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    file: audioFile(),
    model: 'whisper-1',
    response_format: 'json',
    ...overrides,
  }
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const generateContent = vi.fn().mockResolvedValue(answer)
  const client = {
    models: { generateContent, generateContentStream: vi.fn(), list: vi.fn() },
    files: { upload: vi.fn() },
    ...overrides,
  }
  return { client, generateContent, factory: vi.fn().mockReturnValue(client) }
}

test('sends the model, an inline audio part and the abort signal', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  await adapter.transcribe(request(), ctx)

  const sent = generateContent.mock.calls[0][0]
  expect(sent.model).toBe('gemini-2.5-flash')
  expect(sent.contents[0].parts[0]).toMatchObject({
    inlineData: { mimeType: 'audio/mpeg' },
  })
  expect(sent.config.abortSignal).toBe(ctx.signal)
})

test('maps the result back through the translator', async () => {
  const { factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const result = await adapter.transcribe(request({ response_format: 'json' }), ctx)

  expect(result).toEqual({ text: 'hello world' })
})

test('maps a text-format request to the bare string', async () => {
  const { factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const result = await adapter.transcribe(request({ response_format: 'text' }), ctx)

  expect(result).toBe('hello world')
})

test('a refused format surfaces as a 400 GatewayError, not a ProviderError, and calls no upstream', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await adapter
    .transcribe(request({ response_format: 'verbose_json' }), ctx)
    .catch((err: unknown) => err)

  // The distinction this task exists to get right: assertTranscribable
  // rejects the client's request before any upstream call is made, so this
  // must arrive as the GatewayError it is — never reclassified into a
  // ProviderError, which would either resend a doomed request to the next
  // target (if retryable) or wrongly count against this target's circuit
  // breaker (if not), for a call that never happened.
  expect(error).toBeInstanceOf(GatewayError)
  expect(error).not.toBeInstanceOf(ProviderError)
  expect((error as GatewayError).status).toBe(400)
  expect(generateContent).not.toHaveBeenCalled()
})

test('an oversized file is refused the same way, before any encoding or upstream call', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)
  const big = audioFile(21 * 1024 * 1024)

  const error = await adapter.transcribe(request({ file: big }), ctx).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(GatewayError)
  expect(error).not.toBeInstanceOf(ProviderError)
  expect(generateContent).not.toHaveBeenCalled()
})

test('an unresolvable mime type is refused before any upstream call, and is not retried', async () => {
  // Unlike assertTranscribable's refusals, transcription-to-gemini.ts's
  // mimeTypeFor already throws a ProviderError (status 400, retryable:
  // false) for a file it cannot identify — see
  // tests/lib/translate/transcription-to-gemini.test.ts's own coverage of
  // that function. It is built outside transcribe()'s try block for the
  // same structural reason assertTranscribable is: no upstream call has
  // happened yet, so it must not be retried against another target — a
  // non-retryable ProviderError already gets that right without needing to
  // pass through toProviderError at all.
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)
  const unresolvable = audioFile(4, 'clip.xyz', '')

  const error = await adapter
    .transcribe(request({ file: unresolvable }), ctx)
    .catch((err: unknown) => err)

  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).status).toBe(400)
  expect((error as ProviderError).retryable).toBe(false)
  expect(generateContent).not.toHaveBeenCalled()
})

test('an SDK throw arrives already classified', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn().mockRejectedValue(new ApiError({ message: 'nope', status: 400 })),
      generateContentStream: vi.fn(),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await adapter.transcribe(request(), ctx).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(false)
})

test('a retryable SDK throw arrives classified retryable', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn().mockRejectedValue(new ApiError({ message: 'slow', status: 429 })),
      generateContentStream: vi.fn(),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await adapter.transcribe(request(), ctx).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(true)
})
