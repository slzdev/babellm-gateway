import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { transcribeVia } from '@/lib/adapters/openai/audio'
import { withTranscribeUnsupported } from '@/lib/adapters/wrappers'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type { AttemptContext, ChatOnlyAdapter } from '@/lib/adapters/types'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'

const ctx: AttemptContext = {
  upstreamModel: 'whisper-upstream',
  signal: new AbortController().signal,
  requestId: 'req_1',
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

function fakeClient(result: unknown = { text: 'hi' }) {
  const create = vi.fn().mockResolvedValue(result)
  const client = { audio: { transcriptions: { create } } }
  return { create, client }
}

test('substitutes the upstream model name', async () => {
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  await transcribe(request({ model: 'whisper-1' }), ctx)

  expect(create.mock.calls[0][0].model).toBe('whisper-upstream')
})

test('passes the file through untouched — the same object, not a copy', async () => {
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  const file = audioFile()
  await transcribe(request({ file }), ctx)

  expect(create.mock.calls[0][0].file).toBe(file)
})

test('forwards response_format and other client fields', async () => {
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  await transcribe(request({ response_format: 'verbose_json', language: 'en', temperature: 0.2 }), ctx)

  const sent = create.mock.calls[0][0]
  expect(sent.response_format).toBe('verbose_json')
  expect(sent.language).toBe('en')
  expect(sent.temperature).toBe(0.2)
})

test('passes the abort signal and the resolved path', async () => {
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  await transcribe(request(), ctx)

  expect(create.mock.calls[0][1]).toMatchObject({
    signal: ctx.signal,
    path: '/audio/transcriptions',
  })
})

test('a provider-level path override reaches the call', async () => {
  // `transcribeVia` is handed whatever path the caller already resolved
  // (provider config, then a model override layered over it) — it does not
  // resolve paths itself, just like the chat and responses adapters.
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, 'https://api.example/provider/audio')
  await transcribe(request(), ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: 'https://api.example/provider/audio' })
})

test('a model-level path override reaches the call the same way', async () => {
  const { create, client } = fakeClient()
  const transcribe = transcribeVia(client as never, 'https://api.example/model/audio')
  await transcribe(request(), ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: 'https://api.example/model/audio' })
})

test('returns the upstream result unchanged', async () => {
  const result = { text: 'hello world' }
  const { client } = fakeClient(result)
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  const returned = await transcribe(request(), ctx)

  expect(returned).toEqual(result)
})

test('returns a bare string for the text/srt/vtt formats', async () => {
  const { client } = fakeClient('hello world')
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')
  const returned = await transcribe(request({ response_format: 'text' }), ctx)

  expect(returned).toBe('hello world')
})

test('a 429 is classified retryable', async () => {
  const create = vi.fn().mockRejectedValue(
    new OpenAI.APIError(429, { message: 'slow down', code: 'rate_limited' }, 'slow down', undefined),
  )
  const client = { audio: { transcriptions: { create } } }
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')

  await expect(transcribe(request(), ctx)).rejects.toMatchObject({ retryable: true, status: 429 })
})

test('a 400 is classified non-retryable', async () => {
  const create = vi.fn().mockRejectedValue(
    new OpenAI.APIError(400, { message: 'bad file' }, 'bad file', undefined),
  )
  const client = { audio: { transcriptions: { create } } }
  const transcribe = transcribeVia(client as never, '/audio/transcriptions')

  await expect(transcribe(request(), ctx)).rejects.toMatchObject({ retryable: false, status: 400 })
})

function fakeChatOnlyAdapter(chat = vi.fn()): ChatOnlyAdapter {
  return {
    chat: chat as unknown as ChatOnlyAdapter['chat'],
    chatStream: vi.fn() as unknown as ChatOnlyAdapter['chatStream'],
  }
}

test('withTranscribeUnsupported throws, naming the provider and the reason', async () => {
  const adapter = withTranscribeUnsupported(
    fakeChatOnlyAdapter(),
    'anthropic-prod',
    'the Anthropic Messages API has no transcription endpoint and no audio input at all',
  )

  await expect(adapter.transcribe(request(), ctx)).rejects.toThrow(UnsupportedOperationError)
  await expect(adapter.transcribe(request(), ctx)).rejects.toThrow(/anthropic-prod/)
  await expect(adapter.transcribe(request(), ctx)).rejects.toThrow(/no transcription endpoint/)
})

test('withTranscribeUnsupported leaves the wrapped adapter\'s other methods untouched', () => {
  const chat = vi.fn()
  const adapter = withTranscribeUnsupported(fakeChatOnlyAdapter(chat), 'p', 'reason')
  expect(adapter.chat).toBe(chat)
})
