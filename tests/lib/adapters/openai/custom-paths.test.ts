import { describe, expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderConfig, ProviderRuntime } from '@/lib/adapters/types'

/**
 * The SDK hardcodes a path per resource and builds each request as
 * `{ method, path, ...perRequestOptions }`, so a `path` in the options object
 * wins. These tests pin that: the adapters must hand the SDK the SDK's own
 * relative default when nothing is configured, and a configured path already
 * resolved to an absolute URL on the base URL's host — which is how a custom
 * path replaces the base URL's prefix instead of being appended to it.
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

const embeddingsBody = { model: 'fast', input: 'hi' }

const completion = {
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'clone-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
}

const response = {
  id: 'resp_1', object: 'response', created_at: 1, model: 'clone-model',
  status: 'completed', incomplete_details: null,
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
}

function chatClient() {
  const create = vi.fn().mockImplementation(async (params: { stream?: boolean }) =>
    params.stream
      ? { async *[Symbol.asyncIterator]() { /* an empty stream is enough */ } }
      : completion)
  return { create, factory: vi.fn().mockReturnValue({ chat: { completions: { create } } }) }
}

function responsesClient() {
  const create = vi.fn().mockImplementation(async (params: { stream?: boolean }) =>
    params.stream
      ? { async *[Symbol.asyncIterator]() { /* an empty stream is enough */ } }
      : response)
  return { create, factory: vi.fn().mockReturnValue({ responses: { create } }) }
}

function embeddingsClient() {
  const create = vi.fn().mockResolvedValue({
    object: 'list', model: 'clone-model', usage: { prompt_tokens: 1, total_tokens: 1 },
    data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
  })
  return { create, factory: vi.fn().mockReturnValue({ embeddings: { create } }) }
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

    expect(create.mock.calls[0][1]).toMatchObject({ path: 'https://api.example/api/v2/chat' })
  })

  test('sends the configured path on the streaming call too', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await drain(createOpenAIAdapter(rt, factory as never).chatStream(body, ctx))

    expect(create.mock.calls[0][1]).toMatchObject({ path: 'https://api.example/api/v2/chat' })
  })

  test('keeps threading the abort signal alongside the path', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({
      signal: ctx.signal,
      path: 'https://api.example/api/v2/chat',
    })
  })

  test('ignores a responses path, which this flavor never calls', async () => {
    const { create, factory } = chatClient()
    const rt = runtime({ responsesPath: '/api/v2/responses' })
    await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/chat/completions' })
  })
})

describe('responses path', () => {
  test('sends the SDK default when the provider configures nothing', async () => {
    const { create, factory } = responsesClient()
    await createResponsesAdapter(runtime({}), factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/responses' })
  })

  test('sends the configured path instead', async () => {
    const { create, factory } = responsesClient()
    const rt = runtime({ responsesPath: '/api/v2/responses' })
    await createResponsesAdapter(rt, factory as never).chat(body, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({
      path: 'https://api.example/api/v2/responses',
    })
  })

  test('sends the configured path on the streaming call too', async () => {
    const { create, factory } = responsesClient()
    const rt = runtime({ responsesPath: '/api/v2/responses' })
    await drain(createResponsesAdapter(rt, factory as never).chatStream(body, ctx))

    expect(create.mock.calls[0][1]).toMatchObject({
      path: 'https://api.example/api/v2/responses',
    })
  })
})

describe('embeddings path', () => {
  test('sends the SDK default when the provider configures nothing', async () => {
    const { create, factory } = embeddingsClient()
    await createOpenAIAdapter(runtime({}), factory as never).embed!(embeddingsBody, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/embeddings' })
  })

  test('sends the configured path instead', async () => {
    const { create, factory } = embeddingsClient()
    const rt = runtime({ embeddingsPath: '/api/v2/embed' })
    await createOpenAIAdapter(rt, factory as never).embed!(embeddingsBody, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({
      path: 'https://api.example/api/v2/embed',
      signal: ctx.signal,
    })
  })

  test('applies to a Responses provider, which embeds the same way', async () => {
    const { create, factory } = embeddingsClient()
    const rt = runtime({ embeddingsPath: '/api/v2/embed' })
    await createResponsesAdapter(rt, factory as never).embed!(embeddingsBody, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({
      path: 'https://api.example/api/v2/embed',
    })
  })

  test('a chat completions override does not move it', async () => {
    const { create, factory } = embeddingsClient()
    const rt = runtime({ chatCompletionsPath: '/api/v2/chat' })
    await createOpenAIAdapter(rt, factory as never).embed!(embeddingsBody, ctx)

    expect(create.mock.calls[0][1]).toMatchObject({ path: '/embeddings' })
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

    expect(list.mock.calls[0][0]).toMatchObject({
      path: 'https://api.example/api/v2/models',
      signal: ctx.signal,
    })
  })

  test('applies to a Responses provider, which discovers models the same way', async () => {
    const { list, factory } = modelsClient()
    const rt = runtime({ modelsPath: '/api/v2/models' })
    await createResponsesAdapter(rt, factory as never).listModels!({ signal: ctx.signal })

    expect(list.mock.calls[0][0]).toMatchObject({ path: 'https://api.example/api/v2/models' })
  })
})

test('a stored path missing its leading slash is normalised before it is sent', async () => {
  const { create, factory } = chatClient()
  const rt = runtime({ chatCompletionsPath: 'api/v2/chat/' })
  await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: 'https://api.example/api/v2/chat' })
})

/**
 * A provider with no base URL is the official OpenAI, whose base the SDK
 * supplies. Nothing here can resolve an origin, so the path stays relative and
 * the SDK joins it as it always did.
 */
test('a provider with no base URL keeps sending a relative path', async () => {
  const { create, factory } = chatClient()
  const rt = { ...base, baseUrl: null, config: { chatCompletionsPath: '/api/v2/chat' } }
  await createOpenAIAdapter(rt, factory as never).chat(body, ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: '/api/v2/chat' })
})
