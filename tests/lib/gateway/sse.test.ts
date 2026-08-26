import { expect, test, vi } from 'vitest'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { CostBreakdown } from '@/lib/logs/types'
import { sseResponse, startStream, type StreamCapture, type StreamOutcome } from '@/lib/gateway/sse'
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

test('calls costFor only for the chunk that carries usage, not a content-only chunk', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as ChatCompletionChunk
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } } as ChatCompletionChunk
  })())

  const cost: CostBreakdown = {
    inputUsd: '0.000010000', cachedUsd: '0.000000000', outputUsd: '0.000005000',
    totalUsd: '0.000015000', pricing: null,
  }
  const costFor = vi.fn(async () => cost)

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture }, undefined, costFor)
  const body = await res.text()

  // The TTFT-critical property: a content delta must never trigger a lookup.
  expect(costFor).toHaveBeenCalledTimes(1)
  expect(captured!.cost).toEqual(cost)
  expect(body).toContain('"cost":{"currency":"USD"')
})

test('a costFor rejection degrades to a null cost instead of interrupting the stream', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } } as ChatCompletionChunk
  })())

  const costFor = vi.fn(async (): Promise<CostBreakdown | null> => {
    throw new Error('catalog down')
  })

  let outcome: StreamOutcome | null = null
  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (o, capture) => { outcome = o; captured = capture }, undefined, costFor)
  const body = await res.text()

  expect(outcome).toBe('ok')
  expect(captured!.cost).toBeNull()
  expect(captured!.error).toBeNull()
  expect(body).toContain('data: [DONE]')
  expect(body).not.toContain('stream_interrupted')
})

test('relays a usage-bearing chunk untouched when no costFor is supplied', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } } as ChatCompletionChunk
  })())

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture })
  const body = await res.text()

  expect(captured!.usage).toEqual({
    promptTokens: 10, completionTokens: 5, cachedTokens: null, reasoningTokens: null,
  })
  expect(captured!.cost).toBeNull()
  expect(body).not.toContain('"cost"')
})
