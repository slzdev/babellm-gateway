import { expect, test } from 'vitest'
import { responsesStreamProtocol as p } from '@/lib/gateway/protocols/responses'

const identity = { id: 'resp_gw', model: 'virtual' }
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('frames an event with a named event line', () => {
  const framed = decode(p.frame({ type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' } as never, identity))

  expect(framed).toBe('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"hi"}\n\n')
})

test('does not terminate the stream with [DONE]', () => {
  // The real API ends on response.completed; the installed SDK treats [DONE]
  // as optional (openai/core/streaming.js:35).
  expect(p.terminator).toBeNull()
})

test('rewrites the model on events carrying a response, and never the id', () => {
  const framed = decode(p.frame({
    type: 'response.created', sequence_number: 0,
    response: { id: 'resp_upstream', model: 'gpt-5-2026', output: [] },
  } as never, identity))

  // The id is what the client sends back as previous_response_id, so it must
  // stay the provider's own.
  expect(framed).toContain('"id":"resp_upstream"')
  expect(framed).toContain('"model":"virtual"')
})

test('reads usage off the terminal event', () => {
  const usage = p.usageOf({
    type: 'response.completed', sequence_number: 9,
    response: { usage: {
      input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: { cached_tokens: 6 },
      output_tokens_details: { reasoning_tokens: 2 },
    } },
  } as never)

  expect(usage).toEqual({ promptTokens: 10, completionTokens: 4, cachedTokens: 6, reasoningTokens: 2 })
})

test('reports no usage on a non-terminal event', () => {
  expect(p.usageOf({ type: 'response.output_text.delta', sequence_number: 1, delta: 'x' } as never)).toBeNull()
})

test('counts only text and reasoning deltas as content', () => {
  expect(p.isContentDelta({ type: 'response.created', sequence_number: 0 } as never)).toBe(false)
  expect(p.isContentDelta({ type: 'response.in_progress', sequence_number: 1 } as never)).toBe(false)
  expect(p.isContentDelta({ type: 'response.output_text.delta', sequence_number: 2, delta: 'x' } as never)).toBe(true)
  expect(p.isContentDelta({ type: 'response.reasoning_summary_text.delta', sequence_number: 2, delta: 'x' } as never)).toBe(true)
})

test('frames a mid-stream failure as a named error event', () => {
  const framed = decode(p.errorEvent({
    retryable: true, status: 502, type: 'api_error', code: 'upstream_error', message: 'boom',
  }))

  expect(framed).toContain('event: error\n')
  expect(framed).toContain('"type":"error"')
  expect(framed).toContain('"message":"boom"')
})

test('accumulates only output text for payload capture', () => {
  const captured = { usage: null, cost: null, text: '', bytes: 0, truncated: false, error: null, firstDeltaAt: null }
  p.accumulate(captured, { type: 'response.output_text.delta', sequence_number: 1, delta: 'ab' } as never, 100)
  p.accumulate(captured, { type: 'response.reasoning_summary_text.delta', sequence_number: 2, delta: 'zz' } as never, 100)

  // Reasoning is not the assistant's answer, so it stays out of the captured text.
  expect(captured.text).toBe('ab')
})

test('stops accumulating at the byte cap', () => {
  const captured = { usage: null, cost: null, text: '', bytes: 0, truncated: false, error: null, firstDeltaAt: null }
  p.accumulate(captured, { type: 'response.output_text.delta', sequence_number: 1, delta: 'abcdef' } as never, 3)

  expect(captured.truncated).toBe(true)
  expect(captured.text).toBe('')
})
