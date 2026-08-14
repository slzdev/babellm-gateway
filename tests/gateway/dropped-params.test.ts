import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('a responses provider reports the parameters it could not express', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3, stop: ['\n'] },
      apiKey,
    ),
    fakeAdapterByProvider({ resp: { chat: vi.fn().mockResolvedValue(completion('resp')) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')?.split(',').sort())
    .toEqual(['n', 'stop'])
})

test('a chat completions provider reports nothing, because it drops nothing', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'cc', apiFlavor: 'chat_completions' }],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ cc: { chat: vi.fn().mockResolvedValue(completion('cc')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('the header names the flavor of the target that actually served', async () => {
  // The first target is a Responses provider that fails; the request lands on a
  // Chat Completions provider, which drops nothing.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({
      resp: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      cc: { chat: vi.fn().mockResolvedValue(completion('cc')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('a streaming response carries the header too', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'resp-model',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], stream: true, n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ resp: { chatStream: working as never } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBe('n')
  await res.text()
})

test('a gemini target reports what Gemini cannot express', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleChatCompletions(
    chatRequest(
      {
        model: 'house-model',
        messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }],
        logprobs: true,
      },
      apiKey,
    ),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem')) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')?.split(',').sort())
    .toEqual(['logprobs', 'system_message_hoisted'])
})

test('a gemini target reports nothing for a request it can express fully', async () => {
  // `n: 3` is the case that separates the two translators: the Responses
  // flavor drops it, Gemini sends it as candidateCount.
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})
