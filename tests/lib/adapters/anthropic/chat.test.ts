import { expect, test, vi } from 'vitest'
import { createAnthropicAdapter } from '@/lib/adapters/anthropic'
import type { ProviderRuntime } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function runtime(config: Record<string, unknown> = {}): ProviderRuntime {
  return {
    id: 'p1', name: 'anthropic-test', adapter: 'openai_compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    credentials: { apiKey: 'sk-test' }, config,
  }
}

const req = {
  model: 'virtual', messages: [{ role: 'user', content: 'hi' }],
} as ChatCompletionRequest

const ctx = { upstreamModel: 'claude-opus-5', signal: new AbortController().signal, requestId: 'r1' }

function message(text: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function adapterWith(create: unknown, config: Record<string, unknown> = {}, ceiling: number | null = null) {
  const factory = vi.fn().mockReturnValue({ messages: { create } })
  return createAnthropicAdapter(runtime(config), ceiling, factory as never)
}

test('chat translates both ways and targets the resolved messages path', async () => {
  const create = vi.fn().mockResolvedValue(message('hello'))
  const completion = await adapterWith(create).chat(req, ctx)

  const [body, options] = create.mock.calls[0]
  expect(body.model).toBe('claude-opus-5')
  expect(body.stream).toBe(false)
  expect(body.max_tokens).toBe(4096)
  expect(options.path).toBe('/messages')
  expect(options.signal).toBe(ctx.signal)
  expect(completion.choices[0].message.content).toBe('hello')
})

test("the model's catalogued ceiling supplies max_tokens when the client sent none", async () => {
  const create = vi.fn().mockResolvedValue(message('x'))
  await adapterWith(create, {}, 64000).chat(req, ctx)
  expect(create.mock.calls[0][0].max_tokens).toBe(64000)
})

test('a configured messages path resolves against the base URL origin', async () => {
  const create = vi.fn().mockResolvedValue(message('x'))
  await adapterWith(create, { messagesPath: '/anthropic/v1/messages' }).chat(req, ctx)
  expect(create.mock.calls[0][1].path).toBe('https://api.anthropic.com/anthropic/v1/messages')
})

test('chatStream relays translated chunks', async () => {
  async function* events() {
    yield {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 0 } },
    }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  }
  const create = vi.fn().mockResolvedValue(events())

  const chunks = []
  for await (const chunk of adapterWith(create).chatStream(req, ctx)) chunks.push(chunk)

  expect(create.mock.calls[0][0].stream).toBe(true)
  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
})
