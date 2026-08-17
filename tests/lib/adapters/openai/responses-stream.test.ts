import { expect, test, vi } from 'vitest'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ChatCompletionChunk, ProviderRuntime } from '@/lib/adapters/types'
import fixture from '../../../fixtures/openai-responses-tool-call-stream.json'

const runtime: ProviderRuntime = {
  id: 'p1', name: 'responses-provider', adapter: 'openai', baseUrl: null,
  credentials: { apiKey: 'sk-test' }, config: {},
}

const ctx = {
  upstreamModel: 'gpt-5-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const request = {
  model: 'fast',
  messages: [{ role: 'user' as const, content: 'weather?' }],
  stream: true,
}

function streamingClient(events: unknown[] = fixture) {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return { create, factory }
}

async function collect(iterable: AsyncIterable<ChatCompletionChunk>) {
  const out: ChatCompletionChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('opens the upstream stream with stream: true', async () => {
  const { create, factory } = streamingClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await collect(adapter.chatStream(request, ctx))

  expect(create.mock.calls[0][0].stream).toBe(true)
  // Responses always reports usage on completion, so stream_options has no
  // upstream equivalent and must never be sent.
  expect(create.mock.calls[0][0]).not.toHaveProperty('stream_options')
})

test('emits Chat Completions chunks that reassemble the tool call', async () => {
  const { factory } = streamingClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
})

test('an error before the first chunk propagates to the caller', async () => {
  const create = vi.fn().mockRejectedValue(new Error('upstream down'))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  await expect(collect(adapter.chatStream(request, ctx))).rejects.toThrow('upstream down')
})

test('an error thrown mid-stream propagates after the earlier chunks', async () => {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      yield fixture[0]
      yield fixture[3]
      throw new Error('connection reset')
    },
  }))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  const seen: ChatCompletionChunk[] = []
  await expect(async () => {
    for await (const chunk of adapter.chatStream(request, ctx)) seen.push(chunk)
  }).rejects.toThrow('connection reset')
  expect(seen).toHaveLength(1)
})
