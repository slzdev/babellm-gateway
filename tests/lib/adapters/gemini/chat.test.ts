import { expect, test, vi } from 'vitest'
import { createGeminiAdapter } from '@/lib/adapters/gemini'
import type { ProviderRuntime } from '@/lib/adapters/types'
import { ProviderError } from '@/lib/gateway/errors'
import { ApiError } from '@google/genai'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'gemini-prod',
  adapter: 'gemini',
  baseUrl: null,
  credentials: { apiKey: 'g-key' },
  config: {},
}

const ctx = {
  upstreamModel: 'gemini-2.5-flash',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const answer = {
  candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
}

async function* twoChunks() {
  yield { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }
  yield { candidates: [{ content: { parts: [{ text: ' there' }] }, finishReason: 'STOP' }] }
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const generateContent = vi.fn().mockResolvedValue(answer)
  const generateContentStream = vi.fn().mockResolvedValue(twoChunks())
  const client = {
    models: { generateContent, generateContentStream, list: vi.fn() },
    files: { upload: vi.fn() },
    ...overrides,
  }
  return { client, generateContent, generateContentStream, factory: vi.fn().mockReturnValue(client) }
}

test('a chat request is translated, sent, and translated back', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const result = await adapter.chat(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }] },
    ctx,
  )

  expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  }))
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(3)
})

test('the abort signal reaches the upstream call', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  await adapter.chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(generateContent.mock.calls[0][0].config.abortSignal).toBe(ctx.signal)
})

test('the provider config reaches the translator', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(
    { ...runtime, config: { requestReasoningSummary: true } },
    factory as never,
  )

  await adapter.chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(generateContent.mock.calls[0][0].config.thinkingConfig)
    .toEqual({ includeThoughts: true })
})

test('an upstream failure arrives already classified', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn().mockRejectedValue(new ApiError({ message: 'nope', status: 400 })),
      generateContentStream: vi.fn(),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await adapter
    .chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)
    .catch((err: unknown) => err)

  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(false)
})

test('a stream is translated chunk by chunk', async () => {
  const { generateContentStream, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const chunks = []
  for await (const chunk of adapter.chatStream(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )) {
    chunks.push(chunk)
  }

  expect(generateContentStream.mock.calls[0][0].config.abortSignal).toBe(ctx.signal)
  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
  expect(chunks[1].choices[0].delta).toEqual({ content: ' there' })
})

test('a failure while opening a stream arrives classified', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn().mockRejectedValue(new ApiError({ message: 'slow', status: 429 })),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const iterator = adapter.chatStream(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )[Symbol.asyncIterator]()

  const error = await iterator.next().catch((err: unknown) => err)
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(true)
})

test('a failure while draining a stream arrives classified', async () => {
  async function* failing() {
    yield { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }
    throw new ApiError({ message: 'cut off', status: 503 })
  }
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn().mockResolvedValue(failing()),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await (async () => {
    try {
      for await (const chunk of adapter.chatStream(
        { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
        ctx,
      )) { void chunk /* drain */ }
    } catch (err) {
      return err
    }
  })()

  expect(error).toBeInstanceOf(ProviderError)
})

test('images are resolved before the request is built', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/abc', mimeType: 'image/png' })
  const { generateContent, factory } = fakeClient({ files: { upload } })
  const adapter = createGeminiAdapter(runtime, factory as never)

  await adapter.chat({
    model: 'virtual',
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
    }],
  }, ctx)

  expect(generateContent.mock.calls[0][0].contents[0].parts[0])
    .toEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } })
  expect(upload).not.toHaveBeenCalled()
})
