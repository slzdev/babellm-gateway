import { describe, expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ProviderConfig, ProviderRuntime } from '@/lib/adapters/types'

/**
 * The SDK hardcodes a path per resource and builds each request as
 * `{ method, path, ...perRequestOptions }`, so a `path` in the options object
 * wins. These tests pin that: the adapters must hand the SDK the configured
 * path, and the SDK's own default when nothing is configured.
 */

const base: ProviderRuntime = {
  id: 'p1',
  name: 'clone',
  adapter: 'openai_compatible',
  baseUrl: 'https://api.example/v1',
  credentials: { apiKey: 'sk-test' },
  config: {},
}

function runtime(config: ProviderConfig) {
  return { ...base, config }
}

const ctx = {
  upstreamModel: 'clone-model',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const body = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] }

const completion = {
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'clone-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
}

function chatClient() {
  const create = vi.fn().mockImplementation(async (params: { stream?: boolean }) =>
    params.stream
      ? { async *[Symbol.asyncIterator]() { /* an empty stream is enough */ } }
      : completion)
  return { create, factory: vi.fn().mockReturnValue({ chat: { completions: { create } } }) }
}

function modelsClient() {
  const list = vi.fn().mockResolvedValue({
    async *[Symbol.asyncIterator]() { yield { id: 'clone-model' } },
  })
  return { list, factory: vi.fn().mockReturnValue({ models: { list } }) }
}

/** The adapters open the upstream call lazily, so the generator must be run. */
async function drain(stream: AsyncIterable<unknown>) {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('chat completions path', () => {
  test('sends the SDK default when the provider configures nothing', async () => {
    const { create, factory } = chatClient()
    await createOpenAIAdapter(runtime({}), factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/chat/completions' })
  })

  test('sends the configured path instead', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/api/v2/chat' })
  })

  test('sends the configured path on the streaming call too', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await drain(createOpenAIAdapter(rt, factory as never).chatStream(body, ctx))

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/api/v2/chat' })
  })

  test('keeps threading the abort signal alongside the path', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ signal: ctx.signal, path: '/api/v2/chat' })
  })
})

describe('models path', () => {
  test('sends the SDK default when the provider configures nothing', async () => {
    const { list, factory } = modelsClient()
    await createOpenAIAdapter(runtime({}), factory as never)
      .listModels!({ signal: ctx.signal })

    expect(list.mock.calls[0][0]).toMatchObject({ path: '/models' })
  })

  test('sends the configured path instead', async () => {
    const { list, factory } = modelsClient()
    const rt = runtime({ modelsPath: '/api/v2/models' })
    await createOpenAIAdapter(rt, factory as never).listModels!({ signal: ctx.signal })

    expect(list.mock.calls[0][0]).toMatchObject({ path: '/api/v2/models', signal: ctx.signal })
  })
})

test('a stored path missing its leading slash is normalised before it is sent', async () => {
  const { create, factory } = chatClient()
  const rt = runtime({ chatCompletionsPath: 'api/v2/chat/' })
  await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: '/api/v2/chat' })
})
