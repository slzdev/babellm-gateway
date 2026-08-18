import { expect, test, vi } from 'vitest'
import { withForcedChatStream, withForcedResponseStream } from '@/lib/adapters/wrappers'
import type {
  AttemptContext, ChatCompletionChunk, ProviderAdapter, ResponseStreamEvent,
} from '@/lib/adapters/types'

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  requestId: 'req_1',
  signal: new AbortController().signal,
} as AttemptContext

function baseAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    chat: vi.fn(async () => { throw new Error('chat should not be called') }),
    chatStream: async function* (): AsyncIterable<ChatCompletionChunk> {
      yield {
        id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      } as ChatCompletionChunk
    },
    respond: vi.fn(async () => { throw new Error('respond should not be called') }),
    respondStream: async function* (): AsyncIterable<ResponseStreamEvent> {
      yield { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } } as ResponseStreamEvent
    },
    ...overrides,
  } as ProviderAdapter
}

test('withForcedChatStream serves chat() from chatStream()', async () => {
  const adapter = baseAdapter()
  const forced = withForcedChatStream(adapter)

  const result = await forced.chat({ model: 'virtual', messages: [] } as never, ctx)

  expect(result.choices[0].message.content).toBe('hi')
  expect(adapter.chat).not.toHaveBeenCalled()
})

test('withForcedChatStream leaves chatStream and every other method alone', async () => {
  const listModels = vi.fn(async () => [])
  const adapter = baseAdapter({ listModels })
  const forced = withForcedChatStream(adapter)

  expect(forced.chatStream).toBe(adapter.chatStream)
  expect(forced.respond).toBe(adapter.respond)
  expect(forced.respondStream).toBe(adapter.respondStream)
  expect(forced.listModels).toBe(listModels)
})

test('withForcedResponseStream serves respond() from respondStream()', async () => {
  const adapter = baseAdapter()
  const forced = withForcedResponseStream(adapter)

  const result = await forced.respond({ model: 'virtual', input: 'hi' } as never, ctx)

  expect(result).toEqual({ id: 'resp_1', status: 'completed' })
  expect(adapter.respond).not.toHaveBeenCalled()
})

test('withForcedResponseStream leaves chat alone, so the two compose independently', async () => {
  const adapter = baseAdapter()
  const forced = withForcedResponseStream(adapter)

  expect(forced.chat).toBe(adapter.chat)
  expect(forced.chatStream).toBe(adapter.chatStream)
})

test('an upstream failure mid-stream surfaces as a rejected chat(), which is what lets the chain fail over', async () => {
  const adapter = baseAdapter({
    chatStream: async function* (): AsyncIterable<ChatCompletionChunk> {
      yield {
        id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      } as ChatCompletionChunk
      throw new Error('upstream died')
    },
  })

  await expect(
    withForcedChatStream(adapter).chat({ model: 'virtual', messages: [] } as never, ctx),
  ).rejects.toThrow('upstream died')
})
