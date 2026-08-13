import { expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ChatCompletionChunk, ProviderRuntime } from '@/lib/adapters/types'
import fixture from '../../../fixtures/openai-tool-call-stream.json'

const runtime: ProviderRuntime = {
  id: 'p1', name: 'openai-prod', adapter: 'openai', baseUrl: null,
  credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'chat_completions',
}

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const request = { model: 'fast', messages: [{ role: 'user' as const, content: 'weather?' }], stream: true }

function streamingClient(chunks: unknown[] = fixture) {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  return { create, factory }
}

async function collect(iterable: AsyncIterable<ChatCompletionChunk>) {
  const out: ChatCompletionChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('requests usage in the stream by default', async () => {
  const { create, factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await collect(adapter.chatStream(request, ctx))

  const sent = create.mock.calls[0][0]
  expect(sent.stream).toBe(true)
  expect(sent.stream_options).toEqual({ include_usage: true })
})

test('omits stream_options when the provider config disables it', async () => {
  const { create, factory } = streamingClient()
  const adapter = createOpenAIAdapter(
    { ...runtime, config: { disableStreamUsage: true } },
    factory as never,
  )
  await collect(adapter.chatStream(request, ctx))
  expect(create.mock.calls[0][0]).not.toHaveProperty('stream_options')
})

test("a caller's own stream_options overrides the include_usage default", async () => {
  const { create, factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await collect(
    adapter.chatStream({ ...request, stream_options: { include_usage: false } }, ctx),
  )
  expect(create.mock.calls[0][0].stream_options).toEqual({ include_usage: false })
})

test('emits every upstream chunk in order', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))
  expect(chunks).toHaveLength(fixture.length)

  const finishReasons = chunks.map((c) => c.choices[0]?.finish_reason ?? null)
  const expectedFinishReasons = (
    fixture as { choices: { finish_reason: string | null }[] }[]
  ).map((c) => c.choices[0]?.finish_reason ?? null)
  expect(finishReasons).toEqual(expectedFinishReasons)
  expect(chunks[0].choices[0]?.delta.role).toBe('assistant')
  expect(chunks.at(-1)?.usage).toBeDefined()
})

test('tool call argument fragments reassemble into valid JSON', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const args = chunks
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('the tool call id and name arrive on the opening fragment only', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const fragments = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  expect(fragments[0].id).toBe('call_1')
  expect(fragments[0].function?.name).toBe('get_weather')
  expect(fragments.slice(1).every((f) => f.id === undefined)).toBe(true)
})

test('the final chunk carries usage and the finish reason precedes it', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls')
})

test('an error thrown before the first chunk propagates to the caller', async () => {
  const create = vi.fn().mockRejectedValue(new Error('upstream down'))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  const adapter = createOpenAIAdapter(runtime, factory as never)

  await expect(collect(adapter.chatStream(request, ctx))).rejects.toThrow('upstream down')
})

test('an error thrown mid-stream propagates after the earlier chunks', async () => {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      yield fixture[0]
      throw new Error('connection reset')
    },
  }))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  const adapter = createOpenAIAdapter(runtime, factory as never)

  const seen: ChatCompletionChunk[] = []
  await expect(async () => {
    for await (const chunk of adapter.chatStream(request, ctx)) seen.push(chunk)
  }).rejects.toThrow('connection reset')
  expect(seen).toHaveLength(1)
})
