import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { parseSse, parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-tool-call-stream.json'

const body = {
  model: 'house-model',
  messages: [{ role: 'user', content: 'weather?' }],
  stream: true,
}

function streamOf(chunks: unknown[]) {
  return async function* chatStream() {
    for (const chunk of chunks) yield chunk
  }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
})

test('responds with an SSE content type and no-transform caching', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.headers.get('cache-control')).toContain('no-transform')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
})

test('streams every chunk and terminates with [DONE]', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const text = await res.text()

  expect(parseSseChunks(text)).toHaveLength(fixture.length)
  expect(sseTerminated(text)).toBe(true)
})

test('every streamed chunk carries the virtual model and one stable gateway id', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{ id: string; model: string }>

  expect(new Set(chunks.map((c) => c.id)).size).toBe(1)
  expect(chunks[0].id).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(chunks.every((c) => c.model === 'house-model')).toBe(true)
})

test('tool call fragments survive the stream intact', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{
    choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>
  }>

  const args = chunks
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('a failure before the first chunk returns a JSON error, not a stream', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    throw new OpenAI.APIError(429, { message: 'rate limited', code: 'rate_limit_exceeded' }, 'rate limited', undefined)
    yield undefined as never
  }

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )

  expect(res.status).toBe(429)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect((await res.json()).error.message).toContain('rate limited')
})

test('a mid-stream failure emits an error event then [DONE] on an already-committed 200', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield fixture[0]
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  expect(res.status).toBe(200)

  const text = await res.text()
  const events = parseSse(text)
  const errorEvent = JSON.parse(events.at(-2)!.data)

  expect(parseSseChunks(text)).toHaveLength(2)
  expect(errorEvent.error.code).toBe('stream_interrupted')
  expect(errorEvent.error.message).toContain('connection reset')
  expect(sseTerminated(text)).toBe(true)
})

test('a non-streaming request is unaffected by the streaming path', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue({
    id: 'up', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  })

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: false }, apiKey),
    fakeAdapterDeps({ chat }),
  )
  expect(res.headers.get('content-type')).toContain('application/json')
})
