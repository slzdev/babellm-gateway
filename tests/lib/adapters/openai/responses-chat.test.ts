import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'responses-provider',
  adapter: 'openai_compatible',
  baseUrl: 'https://api.example/v1',
  credentials: { apiKey: 'sk-test' },
  config: {},
}

const ctx = {
  upstreamModel: 'gpt-5-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const upstream = {
  id: 'resp_1',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-5-mini',
  status: 'completed',
  incomplete_details: null,
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: {
    input_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 7,
  },
}

function fakeClient(result: unknown = upstream) {
  const create = vi.fn().mockResolvedValue(result)
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return { create, factory }
}

const body = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] }

test('calls the responses endpoint, not chat completions', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)

  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0][0].model).toBe('gpt-5-mini')
  expect(create.mock.calls[0][0].store).toBe(false)
  expect(create.mock.calls[0][0].stream).toBe(false)
})

test('builds the client from credentials and base URL', async () => {
  const { factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)

  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.example/v1' }),
  )
})

test('passes the abort signal to the SDK', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)
  expect(create.mock.calls[0][1]).toMatchObject({ signal: ctx.signal })
})

test('returns a Chat Completions shaped result', async () => {
  const { factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  const result = await adapter.chat(body, ctx)

  expect(result.object).toBe('chat.completion')
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(7)
})

test('the provider config reaches the translator', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(
    { ...runtime, config: { requestReasoningSummary: true } },
    factory as never,
  )
  await adapter.chat(body, ctx)

  expect(create.mock.calls[0][0].reasoning).toEqual({ summary: 'auto' })
})

test('an upstream API error is normalised into a ProviderError', async () => {
  const create = vi.fn().mockRejectedValue(
    new OpenAI.APIError(429, { message: 'slow down', code: 'rate_limit_exceeded' }, 'slow down', undefined),
  )
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  await expect(adapter.chat(body, ctx)).rejects.toMatchObject({
    status: 429,
    retryable: true,
  })
})

test('a 404 from a Responses provider carries the flavor hint', async () => {
  const create = vi.fn().mockRejectedValue(
    new OpenAI.APIError(404, { message: 'Not Found' }, 'Not Found', undefined),
  )
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  await expect(adapter.chat(body, ctx)).rejects.toMatchObject({
    status: 404,
    message: expect.stringContaining('chat_completions'),
  })
})

test('throws when the credentials have no apiKey', () => {
  const { factory } = fakeClient()
  expect(() =>
    createResponsesAdapter({ ...runtime, credentials: {} }, factory as never),
  ).toThrow(/apiKey/i)
})
