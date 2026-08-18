import { expect, test } from 'vitest'
import { fromMessageStream } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const req = { model: 'v', messages: [{ role: 'user', content: 'hi' }] } as ChatCompletionRequest

async function* feed(events: unknown[]) {
  for (const event of events) yield event as never
}

async function collect(events: unknown[], request = req) {
  const out = []
  for await (const chunk of fromMessageStream(feed(events), request, 'claude-opus-5')) {
    out.push(chunk)
  }
  return out
}

const start = {
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 },
  },
}

test('text deltas become content deltas, with the role on the first one', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'he' })
  expect(chunks[1].choices[0].delta).toEqual({ content: 'llo' })
  expect(chunks[2].choices[0].finish_reason).toBe('stop')
  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 7, completion_tokens: 3, total_tokens: 10,
  })
})

test('thinking deltas become reasoning_content', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ])

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'hmm' })
  // The signature is replay state for the model, not content for the client.
  expect(chunks.filter((c) => 'content' in (c.choices[0]?.delta ?? {}))).toHaveLength(0)
})

test('a tool_use block streams as an indexed tool call with json argument deltas', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"Paris"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  ])

  expect(chunks[1].choices[0].delta).toEqual({
    tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
  })
  expect(chunks[2].choices[0].delta).toEqual({
    tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
  })
  expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls')
})

test('two tool_use blocks keep separate tool call indexes', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'f', input: {} } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'g', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
  ])

  const indexes = chunks
    .flatMap((c) => (c.choices[0]?.delta as { tool_calls?: { index: number }[] })?.tool_calls ?? [])
    .map((call) => call.index)
  expect(indexes).toEqual([0, 1, 1])
})

test('a null usage field on message_delta does not erase what message_start reported', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: null, output_tokens: 3 },
    },
  ])

  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 7, completion_tokens: 3, total_tokens: 10,
  })
})

test('stream_options.include_usage false suppresses the usage chunk', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ], { ...req, stream_options: { include_usage: false } } as ChatCompletionRequest)

  expect(chunks.some((c) => c.usage)).toBe(false)
})
