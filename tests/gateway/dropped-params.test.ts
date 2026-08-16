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

test('an openai target reports nothing, because it forwards the request as sent', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'cc' }] })

  const res = await handleChatCompletions(
    chatRequest(
      {
        model: 'house-model',
        messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }],
        logprobs: true,
      },
      apiKey,
    ),
    fakeAdapterByProvider({ cc: { chat: vi.fn().mockResolvedValue(completion('cc')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('the header describes the target that actually served', async () => {
  // The first target is a Gemini provider that fails; the request lands on an
  // OpenAI-shaped provider, which drops nothing.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'gem', priority: 0, adapter: 'gemini' },
      { name: 'cc', priority: 1 },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], logprobs: true },
      apiKey,
    ),
    fakeAdapterByProvider({
      gem: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      cc: { chat: vi.fn().mockResolvedValue(completion('cc')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('a streaming response carries the header too', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gem-model',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest(
      {
        model: 'house-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        logprobs: true,
      },
      apiKey,
    ),
    fakeAdapterByProvider({ gem: { chatStream: working as never } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBe('logprobs')
  await res.text()
})
