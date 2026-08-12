import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

let lines: Array<Record<string, unknown>>

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  lines = []
  vi.spyOn(console, 'log').mockImplementation((written: unknown) => {
    // Defensive: anything else that reaches stdout during a test would
    // otherwise throw inside the spy and fail the test for the wrong reason.
    try {
      lines.push(JSON.parse(written as string))
    } catch {
      // not a gateway log line; ignore
    }
  })
})

/** Waits for the stream's settle callback, which fires after the body drains. */
async function drain(res: Response) {
  await res.text()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('a successful request logs exactly one line', async () => {
  const { apiKey } = await seedGateway()
  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    msg: 'gateway.request',
    model: 'house-model',
    key: 'test key',
    status: 200,
    outcome: 'ok',
    stream: false,
  })
})

test('the line records every attempt made, in order', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { chat: vi.fn().mockResolvedValue(upstreamCompletion) },
    }),
  )

  const attempts = lines[0].attempts as Array<Record<string, unknown>>
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ n: 1, provider: 'primary', status: 503 })
  expect(attempts[1]).toMatchObject({ n: 2, provider: 'backup', status: 200 })
})

test('a failed request still logs its attempts', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'a', priority: 0 }, { name: 'b', priority: 1 }],
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      a: { chat: vi.fn().mockRejectedValue(apiError(500)) },
      b: { chat: vi.fn().mockRejectedValue(apiError(429)) },
    }),
  )

  expect(lines[0]).toMatchObject({ status: 429, outcome: 'error', lvl: 'warn' })
  expect(lines[0].attempts).toHaveLength(2)
})

test('a rejected request with no key logs a null key and no attempts', async () => {
  await seedGateway()
  await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))

  expect(lines[0]).toMatchObject({ key: null, status: 401, outcome: 'error' })
  expect(lines[0].attempts).toEqual([])
})

test('a streaming request logs once, on stream close, with a ttft', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  expect(lines).toHaveLength(0)

  await drain(res)

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ stream: true, status: 200, outcome: 'ok' })
  expect(lines[0].ttft_ms).toBeGreaterThanOrEqual(0)
})

test('a mid-stream failure logs stream_interrupted at error despite the 200', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    }
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await drain(res)

  expect(lines[0]).toMatchObject({ status: 200, outcome: 'stream_interrupted', lvl: 'error' })
  // The catch settles stream_interrupted and the finally then calls
  // settle('ok') with cancelled still false — this is the only path where
  // the first-one-wins guard is what prevents a second line.
  expect(lines).toHaveLength(1)
})

test('a client disconnect logs client_closed exactly once', async () => {
  const { apiKey } = await seedGateway()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })

  const chatStream = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
    }
    await gate
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )

  const reader = res.body!.getReader()
  await reader.read()
  await reader.cancel()
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ outcome: 'client_closed' })
})
