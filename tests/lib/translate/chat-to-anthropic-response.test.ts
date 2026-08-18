import { expect, test } from 'vitest'
import { fromMessage } from '@/lib/translate/chat-to-anthropic'

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  } as never
}

test('text blocks join into the assistant message', () => {
  const out = fromMessage(message({
    content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }],
  }), 'fallback')

  expect(out.id).toBe('msg_1')
  expect(out.object).toBe('chat.completion')
  expect(out.model).toBe('claude-opus-5')
  expect(out.choices[0].message.content).toBe('hello')
  expect(out.choices[0].finish_reason).toBe('stop')
})

test('thinking blocks become reasoning_content and redacted ones are skipped', () => {
  const out = fromMessage(message({
    content: [
      { type: 'thinking', thinking: 'weighing it up' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'answer' },
    ],
  }), 'm')

  const choice = out.choices[0].message as { content: string; reasoning_content?: string }
  expect(choice.reasoning_content).toBe('weighing it up')
  expect(choice.content).toBe('answer')
})

test('tool_use blocks become tool calls with re-serialized arguments', () => {
  const out = fromMessage(message({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
    stop_reason: 'tool_use',
  }), 'm')

  expect(out.choices[0].message.tool_calls).toEqual([{
    id: 'toolu_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  expect(out.choices[0].finish_reason).toBe('tool_calls')
})

test('stop reasons map onto finish reasons', () => {
  const reasonOf = (stop: string, content: unknown[] = [{ type: 'text', text: 'x' }]) =>
    fromMessage(message({ stop_reason: stop, content }), 'm').choices[0].finish_reason

  expect(reasonOf('end_turn')).toBe('stop')
  expect(reasonOf('stop_sequence')).toBe('stop')
  expect(reasonOf('pause_turn')).toBe('stop')
  expect(reasonOf('max_tokens')).toBe('length')
  expect(reasonOf('refusal')).toBe('content_filter')
})

test('truncation outranks a tool call, so a cut-off call is not reported as complete', () => {
  const out = fromMessage(message({
    content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }],
    stop_reason: 'max_tokens',
  }), 'm')

  expect(out.choices[0].finish_reason).toBe('length')
})

test('cache tokens are counted into prompt tokens and reported separately', () => {
  const out = fromMessage(message({
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  }), 'm')

  expect(out.usage).toEqual({
    prompt_tokens: 130,
    completion_tokens: 5,
    total_tokens: 135,
    prompt_tokens_details: { cached_tokens: 100 },
  })
})

test('no reasoning_tokens are invented, because Anthropic reports none', () => {
  const out = fromMessage(message({
    content: [{ type: 'thinking', thinking: 'long thought' }, { type: 'text', text: 'a' }],
  }), 'm')

  expect(out.usage).not.toHaveProperty('completion_tokens_details')
})
