import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderAdapter } from '@/lib/adapters/types'
import { seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-tool-call-stream.json'

const completion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1', type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
}

function gatewayClient(apiKey: string, adapter: Partial<ProviderAdapter>) {
  const deps = {
    createAdapter: () => ({
      async chat() { throw new Error('chat not stubbed') },
      async *chatStream() { throw new Error('chatStream not stubbed') },
      ...adapter,
    }) as ProviderAdapter,
  }

  return new OpenAI({
    apiKey,
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    fetch: ((url: string, init?: RequestInit) =>
      handleChatCompletions(new Request(url, init), deps)) as unknown as typeof fetch,
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '3'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('the SDK completes a non-streaming tool call', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, { chat: async () => completion as never })

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  })

  expect(result.model).toBe('house-model')
  const call = result.choices[0].message.tool_calls?.[0]
  expect(call?.type).toBe('function')
  if (call?.type !== 'function') throw new Error('expected a function tool call')
  expect(call.function.name).toBe('get_weather')
  expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' })
  expect(result.usage?.total_tokens).toBe(52)
})

test('the SDK consumes the stream and reassembles tool call arguments', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {
    chatStream: (async function* () {
      for (const chunk of fixture) yield chunk
    }) as never,
  })

  const stream = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    stream: true,
  })

  let args = ''
  let finishReason: string | null | undefined
  let totalTokens: number | undefined
  const models = new Set<string>()

  for await (const chunk of stream) {
    models.add(chunk.model)
    for (const call of chunk.choices[0]?.delta?.tool_calls ?? []) {
      args += call.function?.arguments ?? ''
    }
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason
    totalTokens = chunk.usage?.total_tokens ?? totalTokens
  }

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  expect(finishReason).toBe('tool_calls')
  expect(totalTokens).toBe(52)
  expect([...models]).toEqual(['house-model'])
})

test('the SDK raises AuthenticationError for a bad key', async () => {
  await seedGateway()
  const client = gatewayClient('sk-bab-wrong', {})

  await expect(
    client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.AuthenticationError)
})

test('the SDK raises NotFoundError for an unknown virtual model', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {})

  await expect(
    client.chat.completions.create({
      model: 'does-not-exist',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.NotFoundError)
})

test('the SDK surfaces an upstream rate limit as RateLimitError', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {
    chat: async () => {
      throw new OpenAI.APIError(429, { message: 'slow down', code: 'rate_limit_exceeded' }, 'slow down', undefined)
    },
  })

  await expect(
    client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.RateLimitError)
})

test('the SDK completes a tool call served by a Responses provider', async () => {
  const { apiKey } = await seedGateway({ apiFlavor: 'responses' })

  const create = vi.fn().mockResolvedValue({
    id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5-mini',
    status: 'completed', incomplete_details: null,
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed',
    }],
    usage: {
      input_tokens: 40, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 52,
    },
  })

  const client = gatewayClient(apiKey, createResponsesAdapter(
    {
      id: 'p', name: 'resp', adapter: 'openai', baseUrl: null,
      credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'responses',
    },
    vi.fn().mockReturnValue({ responses: { create } }) as never,
  ))

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  })

  expect(result.model).toBe('house-model')
  const call = result.choices[0].message.tool_calls?.[0]
  if (call?.type !== 'function') throw new Error('expected a function tool call')
  expect(call.id).toBe('call_1')
  expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' })
  expect(result.usage?.total_tokens).toBe(52)

  // The tool definition reached the upstream in Responses shape.
  expect(create.mock.calls[0][0].tools).toEqual([
    expect.objectContaining({ type: 'function', name: 'get_weather' }),
  ])
})
