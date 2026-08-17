import { expect, test } from 'vitest'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import { sseResponse, startStream, type StreamCapture } from '@/lib/gateway/sse'
import { chatStreamProtocol } from '@/lib/gateway/protocols/chat'

test('records the timestamp of the first content-bearing chunk, not the first chunk', async () => {
  const before = Date.now()
  const started = await startStream<ChatCompletionChunk>((async function* () {
    // The role delta carries no content: it must not count as time-to-first-token.
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } as ChatCompletionChunk
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as ChatCompletionChunk
  })())

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture })
  await res.text()

  expect(captured!.firstDeltaAt).toBeGreaterThanOrEqual(before)
})

test('leaves firstDeltaAt null when no content ever arrived', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] } as ChatCompletionChunk
  })())

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture })
  await res.text()

  expect(captured!.firstDeltaAt).toBeNull()
})

test('still frames chat chunks as unnamed data events terminated by [DONE]', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'up', object: 'chat.completion.chunk', created: 1, model: 'up-m',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as ChatCompletionChunk
  })())

  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'virtual' }, {})
  const body = await res.text()

  expect(body).toContain('data: {')
  expect(body).not.toContain('event: ')
  expect(body).toContain('data: [DONE]')
  // The identity rewrite still applies.
  expect(body).toContain('"id":"chatcmpl-1"')
  expect(body).toContain('"model":"virtual"')
})
