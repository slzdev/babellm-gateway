import { expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'openai-prod',
  adapter: 'openai',
  baseUrl: null,
  credentials: { apiKey: 'sk-test', organization: 'org-1' },
  config: {},
}

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const completion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

function fakeClient() {
  const create = vi.fn().mockResolvedValue(completion)
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  return { create, factory }
}

test('builds the client from credentials and base URL', async () => {
  const { factory } = fakeClient()
  const adapter = createOpenAIAdapter(
    { ...runtime, adapter: 'openai_compatible', baseUrl: 'https://api.x.ai/v1' },
    factory as never,
  )
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.x.ai/v1' }),
  )
})

test('substitutes the upstream model name', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(create.mock.calls[0][0].model).toBe('gpt-4o-mini')
})

test('forwards unknown provider parameters untouched', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat(
    {
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
      search_parameters: { mode: 'auto' },
      temperature: 0.2,
    } as never,
    ctx,
  )

  const sent = create.mock.calls[0][0]
  expect(sent.search_parameters).toEqual({ mode: 'auto' })
  expect(sent.temperature).toBe(0.2)
})

test('never sends stream: true on the non-streaming path', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat(
    { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )
  expect(create.mock.calls[0][0].stream).toBe(false)
})

test('passes the abort signal to the SDK', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)
  expect(create.mock.calls[0][1]).toMatchObject({ signal: ctx.signal })
})

test('returns the upstream completion unchanged', async () => {
  const { factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const result = await adapter.chat(
    { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
    ctx,
  )
  expect(result).toEqual(completion)
})

test('throws when the credentials have no apiKey', () => {
  const { factory } = fakeClient()
  expect(() =>
    createOpenAIAdapter({ ...runtime, credentials: {} }, factory as never),
  ).toThrow(/apiKey/i)
})
