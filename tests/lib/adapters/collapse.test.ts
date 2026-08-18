import { expect, test } from 'vitest'
import { collapseChatStream } from '@/lib/adapters/collapse'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import toolCallStream from '../../fixtures/openai-tool-call-stream.json'

async function* stream(chunks: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk as ChatCompletionChunk
}

/** The shape every OpenAI-compatible chunk shares, so a test only has to
 *  spell the part it is about. */
function chunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-up',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o-mini',
    choices,
    ...extra,
  }
}

test('concatenates content deltas into one message', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: 'lo' }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  ]))

  expect(result.object).toBe('chat.completion')
  expect(result.id).toBe('chatcmpl-up')
  expect(result.model).toBe('gpt-4o-mini')
  expect(result.created).toBe(1)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.role).toBe('assistant')
  expect(result.choices[0].message.content).toBe('Hello')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('reassembles a tool call from the streamed fixture', async () => {
  const result = await collapseChatStream(stream(toolCallStream))

  expect(result.choices[0].finish_reason).toBe('tool_calls')
  expect(result.choices[0].message.tool_calls).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  // The fixture's last chunk carries usage and an EMPTY choices array. It must
  // contribute usage without inventing a second choice.
  expect(result.choices).toHaveLength(1)
  expect(result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 })
})

test('merges two tool calls by their own index, not the choice index', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x"' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y"' } },
    ] }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: ':2}' } },
      { index: 0, function: { arguments: ':1}' } },
    ] }, finish_reason: 'tool_calls' }]),
  ]))

  expect(result.choices[0].message.tool_calls).toEqual([
    { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
    { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y":2}' } },
  ])
})

test('accumulates reasoning_content separately from content', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { reasoning_content: 'ing' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]),
  ]))

  const message = result.choices[0].message as { content: string | null; reasoning_content?: string }
  expect(message.content).toBe('answer')
  expect(message.reasoning_content).toBe('thinking')
})

test('content absent throughout collapses to null, not an empty string', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }]),
  ]))

  expect(result.choices[0].message.content).toBeNull()
})

test('an empty content delta still yields an empty string, not null', async () => {
  // The provider said "content: ''" — that is a statement, unlike never
  // mentioning content at all.
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }]),
  ]))

  expect(result.choices[0].message.content).toBe('')
})

test('emits multiple choices in index order regardless of arrival order', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 1, delta: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }]),
    chunk([{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: 'stop' }]),
  ]))

  expect(result.choices.map((c) => c.index)).toEqual([0, 1])
  expect(result.choices[0].message.content).toBe('first')
  expect(result.choices[1].message.content).toBe('second')
})

test('usage stays undefined when no chunk carried any', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]),
  ]))

  expect(result.usage).toBeUndefined()
})

test('concatenates logprobs across chunks and leaves them null when absent', async () => {
  const withLogprobs = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'a' }, finish_reason: null, logprobs: { content: [{ token: 'a' }] } }]),
    chunk([{ index: 0, delta: { content: 'b' }, finish_reason: 'stop', logprobs: { content: [{ token: 'b' }] } }]),
  ]))
  expect(withLogprobs.choices[0].logprobs).toEqual({ content: [{ token: 'a' }, { token: 'b' }], refusal: null })

  const without = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }]),
  ]))
  expect(without.choices[0].logprobs).toBeNull()
})

test('a stream that yields nothing throws rather than returning an empty completion', async () => {
  await expect(collapseChatStream(stream([]))).rejects.toThrow(
    /stream ended without producing/i,
  )
})

test('propagates an error thrown mid-stream', async () => {
  async function* failing(): AsyncIterable<ChatCompletionChunk> {
    yield chunk([{ index: 0, delta: { content: 'a' }, finish_reason: null }]) as ChatCompletionChunk
    throw new Error('upstream exploded')
  }

  await expect(collapseChatStream(failing())).rejects.toThrow('upstream exploded')
})
