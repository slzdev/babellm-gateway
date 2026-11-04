import { expect, test } from 'vitest'
import { readChatResponse, type PlaygroundStreamEvent } from '@/lib/playground/stream'

async function collect(response: Response) {
  const events: PlaygroundStreamEvent[] = []
  for await (const event of readChatResponse(response)) events.push(event)
  return events
}

function sse(text: string, byteByByte = false) {
  const bytes = new TextEncoder().encode(text)
  const chunks = byteByByte ? Array.from(bytes, (byte) => Uint8Array.of(byte)) : [bytes]
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function frame(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

test('reads content and reasoning deltas followed by the actual finish reason', async () => {
  const response = sse(
    frame({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })
    + frame({ choices: [{ delta: { content: 'Hello', reasoning_content: 'Think' } }] })
    + frame({ choices: [{ delta: { content: ' world' } }] })
    + frame({ choices: [{ delta: {}, finish_reason: 'length' }] })
    + 'data: [DONE]\n\n',
  )
  expect(await collect(response)).toEqual([
    { type: 'delta', content: 'Hello', reasoning: 'Think' },
    { type: 'delta', content: ' world', reasoning: '' },
    { type: 'finish', reason: 'length' },
  ])
  expect(response.body?.locked).toBe(false)
})

test('decodes fragmented UTF-8 and CRLF boundaries without corrupting text or events', async () => {
  expect(await collect(sse(
    ': heartbeat\r\n\r\n'
    + 'event: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"hé🙂","reasoning_content":"思"}}]}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n', true,
  ))).toEqual([{ type: 'delta', content: 'hé🙂', reasoning: '思' }])
})

test('keeps usage-only chunks after finish and preserves unknown cost', async () => {
  expect(await collect(sse(
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: null } })
    + 'data: [DONE]\n\n',
  ))).toEqual([
    { type: 'finish', reason: 'stop' },
    { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: null } },
  ])
})

test('reads a nonstream completion including reasoning and priced usage', async () => {
  expect(await collect(Response.json({
    choices: [{ message: { role: 'assistant', content: 'Answer', reasoning_content: 'Plan' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 2, cost: { total: '0.000001234' } },
  }))).toEqual([
    { type: 'delta', content: 'Answer', reasoning: 'Plan' },
    { type: 'finish', reason: 'stop' },
    { type: 'usage', usage: { completion_tokens: 2, cost: { total: '0.000001234' } } },
  ])
})

test('does not invent absent usage, token counts or cost', async () => {
  expect(await collect(Response.json({
    choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
  }))).toEqual([
    { type: 'delta', content: 'Hello', reasoning: '' },
    { type: 'finish', reason: 'stop' },
  ])
})

test('reports gateway HTTP error messages with the status', async () => {
  await expect(collect(Response.json({ error: { message: 'This API key has been disabled.' } }, { status: 401 })))
    .rejects.toThrow(/401.*API key has been disabled/i)
})

test('reports a useful status when the HTTP error body is not JSON', async () => {
  await expect(collect(new Response('bad gateway', { status: 502 }))).rejects.toThrow(/502/)
})

test('throws an in-stream gateway error instead of consuming DONE as success', async () => {
  const response = sse(frame({ error: { message: 'Provider disconnected.', code: 'stream_interrupted' } }) + 'data: [DONE]\n\n')
  await expect(collect(response)).rejects.toThrow(/Provider disconnected/)
  expect(response.body?.locked).toBe(false)
})

test.each([
  ['invalid JSON', 'data: {oops}\n\n'],
  ['invalid envelope', 'data: null\n\n'],
  ['invalid delta', frame({ choices: [{ delta: { content: 42 } }] })],
])('rejects malformed SSE %s', async (_, text) => {
  await expect(collect(sse(text + 'data: [DONE]\n\n'))).rejects.toThrow(/invalid|malformed/i)
})

test('rejects malformed nonstream JSON and missing completion choices', async () => {
  await expect(collect(new Response('{oops}', { headers: { 'content-type': 'application/json' } })))
    .rejects.toThrow(/invalid|malformed/i)
  await expect(collect(Response.json({ unexpected: 'envelope' }))).rejects.toThrow(/invalid|malformed/i)
})

test('rejects EOF without DONE even after a finish reason', async () => {
  await expect(collect(sse(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))))
    .rejects.toThrow(/ended|incomplete|interrupted/i)
})

test('rejects a successful SSE response without a body', async () => {
  await expect(collect(new Response(null, { headers: { 'content-type': 'text/event-stream' } })))
    .rejects.toThrow(/body|empty/i)
})

test('cancels and unlocks the underlying stream when the consumer stops early', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: 'partial' } }] })))
    },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } })
  for await (const event of readChatResponse(response)) {
    expect(event).toEqual({ type: 'delta', content: 'partial', reasoning: '' })
    break
  }
  expect(cancelled).toBe(true)
  expect(response.body?.locked).toBe(false)
})
