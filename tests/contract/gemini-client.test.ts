import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { createGeminiAdapter } from '@/lib/adapters/gemini'
import { resolveProviderRuntime } from '@/lib/adapters/registry'
import { withRespondViaChat, withTranscribeUnsupported } from '@/lib/adapters/wrappers'
import type { ProviderRow } from '@/lib/db/schema'
import { seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const answer = {
  modelVersion: 'gemini-2.5-flash-001',
  candidates: [{
    content: { role: 'model', parts: [{ text: 'It is sunny in Paris.' }] },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 },
}

const toolAnswer = {
  modelVersion: 'gemini-2.5-flash-001',
  candidates: [{
    content: {
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
    },
    finishReason: 'STOP',
  }],
}

/**
 * A gateway-backed OpenAI client whose upstream is the real Gemini adapter over
 * a fake SDK client. `sent` collects what Gemini was actually asked for, which
 * is what makes the request-side translation observable from a contract test.
 */
function gatewayClient(apiKey: string, responses: unknown[]) {
  const sent: Record<string, unknown>[] = []
  const remaining = [...responses]

  const fakeGenAI = {
    models: {
      generateContent: async (params: Record<string, unknown>) => {
        sent.push(params)
        return remaining.shift()
      },
      generateContentStream: async (params: Record<string, unknown>) => {
        sent.push(params)
        const response = remaining.shift()
        return (async function* () {
          yield response
        })()
      },
      list: async () => (async function* () {})(),
    },
    files: { upload: async () => ({ uri: 'files/x', mimeType: 'image/png' }) },
  }

  const deps = {
    createAdapter: (provider: ProviderRow) =>
      withTranscribeUnsupported(
        withRespondViaChat(
          createGeminiAdapter(resolveProviderRuntime(provider), () => fakeGenAI as never),
          provider.name,
        ),
        provider.name,
        'this contract test has no transcription fixture',
      ),
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    fetch: ((url: string, init?: RequestInit) =>
      handleChatCompletions(new Request(url, init), deps)) as unknown as typeof fetch,
  })

  return { client, sent }
}

async function seedGemini() {
  return seedGateway({
    adapter: 'gemini',
    credentials: { apiKey: 'g-key' },
    upstreamModel: 'gemini-2.5-flash',
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('the SDK completes a non-streaming request through the Gemini adapter', async () => {
  const { apiKey } = await seedGemini()
  const { client, sent } = gatewayClient(apiKey, [answer])

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Paris?' },
    ],
  })

  expect(sent[0]).toMatchObject({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'weather in Paris?' }] }],
  })
  expect((sent[0].config as { systemInstruction: string }).systemInstruction).toBe('be terse')

  expect(result.choices[0].message.content).toBe('It is sunny in Paris.')
  expect(result.choices[0].finish_reason).toBe('stop')
  expect(result.usage?.total_tokens).toBe(52)
  // The gateway stamps its own identity over the upstream's.
  expect(result.model).toBe('house-model')
  expect(result.id.startsWith('chatcmpl-')).toBe(true)
})

test('the SDK streams through the Gemini adapter', async () => {
  const { apiKey } = await seedGemini()
  const { client } = gatewayClient(apiKey, [answer])

  const stream = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    stream: true,
  })

  const deltas: string[] = []
  let usageSeen = false
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content
    if (content) deltas.push(content)
    if (chunk.usage) usageSeen = true
  }

  expect(deltas.join('')).toBe('It is sunny in Paris.')
  expect(usageSeen).toBe(true)
})

test('a tool call round trip correlates the result back to its function name', async () => {
  const { apiKey } = await seedGemini()
  const { client, sent } = gatewayClient(apiKey, [toolAnswer, answer])

  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }]

  const first = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools,
  })

  const call = first.choices[0].message.tool_calls?.[0]
  expect(first.choices[0].finish_reason).toBe('tool_calls')
  if (call?.type !== 'function') throw new Error('expected a function tool call')
  expect(call.function.name).toBe('get_weather')

  await client.chat.completions.create({
    model: 'house-model',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      first.choices[0].message,
      { role: 'tool', tool_call_id: call!.id, content: '{"temp":21}' },
    ],
    tools,
  })

  // The client echoed back an id the gateway synthesized; the translator has to
  // resolve it to the function's name, because that is what Gemini keys on.
  const contents = sent[1].contents as { role: string; parts: unknown[] }[]
  expect(contents.at(-1)?.parts[0]).toEqual({
    functionResponse: { id: call!.id, name: 'get_weather', response: { temp: 21 } },
  })
})
