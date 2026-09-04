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
  upstreamModel: 'gemini-embedding-001',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

function fakeClient(answer: unknown = { embeddings: [{ values: [0.1, 0.2] }] }) {
  const embedContent = vi.fn().mockResolvedValue(answer)
  const client = {
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent,
      list: vi.fn(),
    },
    files: { upload: vi.fn() },
  }
  return { embedContent, factory: vi.fn().mockReturnValue(client) }
}

function adapterWith(...args: Parameters<typeof fakeClient>) {
  const fake = fakeClient(...args)
  return { ...fake, adapter: createGeminiAdapter(runtime, fake.factory as never) }
}

test('an embeddings request is translated, sent, and translated back', async () => {
  const { adapter, embedContent } = adapterWith({
    embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
  })

  const result = await adapter.embed!({ model: 'virtual', input: ['a', 'b'] }, ctx)

  expect(embedContent).toHaveBeenCalledWith(expect.objectContaining({
    model: 'gemini-embedding-001',
    contents: ['a', 'b'],
  }))
  expect(result.object).toBe('list')
  expect(result.model).toBe('gemini-embedding-001')
  expect(result.data.map((entry) => entry.index)).toEqual([0, 1])
  expect(result.data[1].embedding).toEqual([0.3, 0.4])
})

test('dimensions reaches the sdk as outputDimensionality', async () => {
  const { adapter, embedContent } = adapterWith()

  await adapter.embed!({ model: 'virtual', input: 'a', dimensions: 256 }, ctx)

  expect(embedContent.mock.calls[0][0].config.outputDimensionality).toBe(256)
})

test('the abort signal reaches the upstream call', async () => {
  const { adapter, embedContent } = adapterWith()

  await adapter.embed!({ model: 'virtual', input: 'a' }, ctx)

  expect(embedContent.mock.calls[0][0].config.abortSignal).toBe(ctx.signal)
})

test('an upstream failure arrives already classified', async () => {
  const fake = fakeClient()
  fake.factory.mockReturnValue({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn().mockRejectedValue(new ApiError({ message: 'nope', status: 400 })),
      list: vi.fn(),
    },
    files: { upload: vi.fn() },
  })
  const adapter = createGeminiAdapter(runtime, fake.factory as never)

  await expect(adapter.embed!({ model: 'virtual', input: 'a' }, ctx)).rejects.toMatchObject({
    status: 400,
    retryable: false,
  })
})

test('a 429 from the upstream stays retryable', async () => {
  const fake = fakeClient()
  fake.factory.mockReturnValue({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn().mockRejectedValue(new ApiError({ message: 'slow down', status: 429 })),
      list: vi.fn(),
    },
    files: { upload: vi.fn() },
  })
  const adapter = createGeminiAdapter(runtime, fake.factory as never)

  await expect(adapter.embed!({ model: 'virtual', input: 'a' }, ctx)).rejects.toMatchObject({
    status: 429,
    retryable: true,
  })
})

test('a token-array input never reaches the client, and keeps its 400', async () => {
  const { adapter, embedContent } = adapterWith()

  // The refusal is thrown from inside the adapter's try/catch, so this also
  // pins that toProviderError hands a ProviderError back untouched rather than
  // reclassifying it as a 502 upstream failure.
  const failure = await adapter.embed!({ model: 'virtual', input: [1, 2, 3] }, ctx)
    .catch((err: unknown) => err)

  expect(failure).toBeInstanceOf(ProviderError)
  expect(failure).toMatchObject({ status: 400, code: 'unsupported_input', retryable: false })
  expect(embedContent).not.toHaveBeenCalled()
})

test('a response with no embeddings becomes a retryable 502', async () => {
  const { adapter } = adapterWith({})

  await expect(adapter.embed!({ model: 'virtual', input: 'a' }, ctx)).rejects.toMatchObject({
    status: 502,
    retryable: true,
  })
})
