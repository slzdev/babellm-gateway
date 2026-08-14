import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import {
  chatRequest, fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedTargets,
} from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function completion(from = 'gpt-4o-mini') {
  return {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 1, model: from,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('sends the target\'s service tier upstream', async () => {
  const { apiKey } = await seedGateway({ serviceTier: 'flex' })
  const chat = vi.fn().mockResolvedValue(completion())

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))

  expect(chat.mock.calls[0][0].service_tier).toBe('flex')
})

test('leaves the request untouched when the target sets no tier', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(completion())

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))

  // Absent, not null or undefined-valued: "(none)" must not put a key on the
  // wire that the client never sent, because some upstreams reject an explicit
  // null where they accept an omission.
  expect('service_tier' in chat.mock.calls[0][0]).toBe(false)
})

test('the target\'s tier overrides one the client sent', async () => {
  const { apiKey } = await seedGateway({ serviceTier: 'priority' })
  const chat = vi.fn().mockResolvedValue(completion())

  await handleChatCompletions(
    chatRequest({ ...body, service_tier: 'flex' }, apiKey),
    fakeAdapterDeps({ chat }),
  )

  expect(chat.mock.calls[0][0].service_tier).toBe('priority')
})

test('a client tier survives when the target configures none', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(completion())

  await handleChatCompletions(
    chatRequest({ ...body, service_tier: 'flex' }, apiKey),
    fakeAdapterDeps({ chat }),
  )

  // "(none)" means the gateway does not touch the request — which includes not
  // stripping a tier the caller chose for itself.
  expect(chat.mock.calls[0][0].service_tier).toBe('flex')
})

test('applies the tier on the streaming path too', async () => {
  const { apiKey } = await seedGateway({ serviceTier: 'fast' })
  const chatStream = vi.fn().mockImplementation(async function* () {
    yield {
      id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  })

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream }),
  )
  await res.text()

  expect(chatStream.mock.calls[0][0].service_tier).toBe('fast')
})

test('each target in a failover chain applies its own tier', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'first', priority: 1, serviceTier: 'ultrafast' },
      { name: 'second', priority: 2, serviceTier: 'default' },
    ],
  })
  const first = vi.fn().mockRejectedValue(apiError(429))
  const second = vi.fn().mockResolvedValue(completion('second-model'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({ first: { chat: first }, second: { chat: second } }),
  )

  expect(res.status).toBe(200)
  expect(first.mock.calls[0][0].service_tier).toBe('ultrafast')
  // The failover target must not inherit the body the first attempt was given.
  expect(second.mock.calls[0][0].service_tier).toBe('default')
})

test('a tier on one target does not leak onto an untiered sibling', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'first', priority: 1, serviceTier: 'scale' },
      { name: 'second', priority: 2 },
    ],
  })
  const first = vi.fn().mockRejectedValue(apiError(429))
  const second = vi.fn().mockResolvedValue(completion('second-model'))

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({ first: { chat: first }, second: { chat: second } }),
  )

  expect('service_tier' in second.mock.calls[0][0]).toBe(false)
})

test('a gemini target reports the tier it cannot express', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'gem', adapter: 'gemini', serviceTier: 'flex' }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem-model')) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')?.split(','))
    .toContain('service_tier')
})

test('a gemini target with no tier reports nothing', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'gem', adapter: 'gemini' }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem-model')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})
