import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { handleTranscriptions } from '@/lib/gateway/transcriptions-handler'
import { createAnthropicAdapter } from '@/lib/adapters/anthropic'
import { withRespondViaChat } from '@/lib/adapters/wrappers'
import type { ProviderAdapter, ProviderRuntime, TranscriptionVerbose } from '@/lib/adapters/types'
import { seedGateway, seedTargets } from '../helpers/gateway'
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

// `handler` defaults to the chat ingress, which every pre-existing test here
// exercises; the Responses and Transcriptions contract tests below pass
// handleResponses / handleTranscriptions instead, so all three dialects can
// drive the same real OpenAI SDK against a fetch that never leaves the
// process.
function gatewayClient(
  apiKey: string,
  adapter: Partial<ProviderAdapter>,
  handler: (request: Request, deps: { createAdapter: () => ProviderAdapter }) => Promise<Response> = handleChatCompletions,
) {
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
      handler(new Request(url, init), deps)) as unknown as typeof fetch,
  })
}

function runtime(name: string): ProviderRuntime {
  return {
    id: name, name, adapter: 'openai', baseUrl: 'https://api.anthropic.com/v1',
    credentials: { apiKey: 'sk-test' }, config: {},
  }
}

function anthropicMessage(text: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

function response(id: string) {
  return {
    id, object: 'response', created_at: 1, model: 'up-model', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
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

test('the SDK parses a Chat Completions response from an anthropic_messages model', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  const create = vi.fn().mockResolvedValue(anthropicMessage('from anthropic'))
  const factory = vi.fn().mockReturnValue({ messages: { create } })
  const adapter = withRespondViaChat(
    createAnthropicAdapter(runtime('claude'), null, factory as never),
    'claude',
  )
  const client = gatewayClient(apiKey, adapter)

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'hi' }],
  })

  expect(result.choices[0].message.content).toBe('from anthropic')
})

test('the openai SDK can call responses.create against the gateway', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const client = gatewayClient(apiKey, { respond: async () => response('resp_1') as never }, handleResponses)

  const result = await client.responses.create({ model: 'house-model', input: 'hi' })

  expect(result.id).toBe('resp_1')
  expect(result.output[0].type).toBe('message')
})

test('the openai SDK can stream responses.create against the gateway', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const client = gatewayClient(apiKey, {
    respondStream: (async function* () {
      yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', model: 'up', output: [] } }
      yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
      yield { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', model: 'up', output: [] } }
    }) as never,
  }, handleResponses)

  const seen: number[] = []
  for await (const event of await client.responses.create({ model: 'house-model', input: 'hi', stream: true })) {
    seen.push((event as { sequence_number: number }).sequence_number)
  }

  // The SDK parses our framing, and sequence numbers arrive in order.
  expect(seen).toEqual([0, 1, 2])
})

// ---------------------------------------------------------------------------
// Audio transcriptions
//
// The end-to-end suite (tests/gateway/transcriptions.test.ts) builds its own
// FormData and reads the response with `res.json()` / `res.text()` — it
// checks the gateway against the gateway's own idea of the wire format. Here
// the SDK builds the multipart body (its own boundary, its own `Uploadable`
// handling of a web `File`) and the SDK decides how to parse what comes back:
// `openai-node` hands back a parsed object when the response content type is
// `application/json` and a bare string otherwise. `toResponse` picks that
// content type by sniffing the result's shape on our side; these tests prove
// the two decisions agree, in both directions, for every format that could
// disagree.
// ---------------------------------------------------------------------------

function audioFile(name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type })
}

const verboseTranscription: TranscriptionVerbose = {
  duration: 1.5,
  language: 'english',
  text: 'hello there',
  segments: [{
    id: 0,
    seek: 0,
    start: 0,
    end: 1.5,
    text: 'hello there',
    tokens: [1, 2],
    temperature: 0,
    avg_logprob: -0.1,
    compression_ratio: 1.2,
    no_speech_prob: 0.01,
  }],
}

test('the SDK returns a parsed object, not a string, for a json transcription', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, { transcribe: async () => ({ text: 'hello there' }) }, handleTranscriptions)

  const result = await client.audio.transcriptions.create({
    file: audioFile(),
    model: 'house-model',
    response_format: 'json',
  })

  // `typeof` is the real assertion: the SDK only reads `.text` off a value it
  // parsed as JSON, which it only does when the response content type says so.
  expect(typeof result).toBe('object')
  expect(result.text).toBe('hello there')
})

test('the SDK returns a parsed object with its segments intact for a verbose_json transcription', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, { transcribe: async () => verboseTranscription }, handleTranscriptions)

  const result = await client.audio.transcriptions.create({
    file: audioFile(),
    model: 'house-model',
    response_format: 'verbose_json',
  })

  expect(typeof result).toBe('object')
  expect(result.segments?.[0]?.text).toBe('hello there')
})

for (const format of ['text', 'srt', 'vtt'] as const) {
  test(`the SDK returns a bare string, not a parsed object, for a ${format} transcription`, async () => {
    const { apiKey } = await seedGateway()
    const body = format === 'text' ? 'hello there' : `${format} body for hello there`
    const client = gatewayClient(apiKey, { transcribe: async () => body }, handleTranscriptions)

    const result = await client.audio.transcriptions.create({
      file: audioFile(),
      model: 'house-model',
      response_format: format,
    })

    expect(typeof result).toBe('string')
    expect(result).toBe(body)
  })
}
