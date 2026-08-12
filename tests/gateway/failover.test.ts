import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { resetCursors } from '@/lib/gateway/rr-cursor'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'f'.repeat(64)
  resetCursors()
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('failover walks to the next target when the first is retryably down', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
    }),
  )

  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe('backup')
})

test('the response headers name the target that actually served', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('backup-model')
})

test('a fatal error from the first target is not failed over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })
  const backupChat = vi.fn().mockResolvedValue(completion('backup'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(400, 'context_length_exceeded')) },
      backup: { chat: backupChat },
    }),
  )

  expect(res.status).toBe(400)
  expect(backupChat).not.toHaveBeenCalled()
})

test('an exhausted chain returns the last provider error', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(500, 'server error')) },
      b: { chat: vi.fn().mockRejectedValue(apiError(429, 'slow down')) },
    }),
  )

  expect(res.status).toBe(429)
  expect((await res.json()).error.message).toContain('slow down')
})

test('max_attempts caps how many targets are tried', async () => {
  const { apiKey } = await seedTargets({
    maxAttempts: 2,
    targets: [
      { name: 'a', priority: 0 }, { name: 'b', priority: 1 }, { name: 'c', priority: 2 },
    ],
  })
  const cChat = vi.fn().mockResolvedValue(completion('c'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      b: { chat: vi.fn().mockRejectedValue(apiError(503)) },
      c: { chat: cChat },
    }),
  )

  expect(res.status).toBe(503)
  expect(cChat).not.toHaveBeenCalled()
})

test('a disabled target is never in the chain', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'off', priority: 0, enabled: false }, { name: 'on', priority: 1 }],
  })
  const offChat = vi.fn()

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      off: { chat: offChat },
      on: { chat: vi.fn().mockResolvedValue(completion('on')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(offChat).not.toHaveBeenCalled()
})

test('an unimplemented adapter type is skipped rather than failing the model', async () => {
  // A gemini target sitting beside a healthy openai one must not break the
  // model. The injected createAdapter throws for the gemini target by hand so
  // the skip stays pinned even after the real registry gains a gemini adapter
  // and stops throwing; tests/gateway/chat.test.ts covers the registry itself.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'gem', priority: 0, adapter: 'gemini' },
      { name: 'oai', priority: 1 },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    {
      createAdapter: (provider) => {
        if (provider.adapter === 'gemini') {
          throw new UnsupportedOperationError('the "gemini" adapter is not available yet.')
        }
        return { chat: async () => completion('oai') } as never
      },
    },
  )

  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe('oai')
})

test('round robin spreads successive requests across targets', async () => {
  const { apiKey } = await seedTargets({
    policy: 'round_robin',
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })
  const deps = fakeAdapterByProvider({
    a: { chat: vi.fn().mockResolvedValue(completion('a')) },
    b: { chat: vi.fn().mockResolvedValue(completion('b')) },
  })

  const first = await handleChatCompletions(chatRequest(body, apiKey), deps)
  const second = await handleChatCompletions(chatRequest(body, apiKey), deps)
  const third = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(first.headers.get('x-babellm-provider')).toBe('a')
  expect(second.headers.get('x-babellm-provider')).toBe('b')
  expect(third.headers.get('x-babellm-provider')).toBe('a')
})

test('weighted routing sends everything to the only positively-weighted target', async () => {
  // A deterministic weighted case that needs no RNG injection: with one
  // target at weight 0 it can never be drawn first.
  const { apiKey } = await seedTargets({
    policy: 'weighted',
    targets: [{ name: 'never', weight: 0 }, { name: 'always', weight: 100 }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      never: { chat: vi.fn() },
      always: { chat: vi.fn().mockResolvedValue(completion('always')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('always')
})

test('a stream that fails before its first chunk fails over silently', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const failing = async function* () {
    throw apiError(503, 'down')
    yield undefined as never
  }
  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'backup-model',
      choices: [{ index: 0, delta: { content: 'from backup' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      primary: { chatStream: failing as never },
      backup: { chatStream: working as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  const text = await res.text()
  expect(parseSseChunks(text)).toHaveLength(1)
  expect(sseTerminated(text)).toBe(true)
})

test('a stream that fails after its first chunk is not failed over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })
  const backupStream = vi.fn()

  const halfway = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'primary-model',
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    }
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      primary: { chatStream: halfway as never },
      backup: { chatStream: backupStream as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('primary')
  await res.text()
  expect(backupStream).not.toHaveBeenCalled()
})
