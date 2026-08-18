import { expect, test } from 'vitest'
import { droppedParams } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function req(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'v', messages: [{ role: 'user', content: 'hi' }], ...overrides } as ChatCompletionRequest
}

test('a plain request drops nothing', () => {
  expect(droppedParams(req())).toEqual([])
})

test('parameters the Messages API has no equivalent for are reported', () => {
  const dropped = droppedParams(req({
    seed: 1, response_format: { type: 'json_object' }, service_tier: 'flex',
    n: 2,
  } as Partial<ChatCompletionRequest>))

  expect(dropped).toEqual(expect.arrayContaining([
    'seed', 'response_format', 'service_tier', 'n',
  ]))
})

test('n of 1 and logprobs false mean the default and are not reported', () => {
  expect(droppedParams(req({ n: 1, logprobs: false } as Partial<ChatCompletionRequest>))).toEqual([])
})

test('penalties and logit_bias are reported', () => {
  const dropped = droppedParams(req({
    presence_penalty: 0.5, frequency_penalty: 0.5, logit_bias: { '1': 1 },
  } as Partial<ChatCompletionRequest>))

  expect(dropped).toEqual(expect.arrayContaining([
    'presence_penalty', 'frequency_penalty', 'logit_bias',
  ]))
})

test('a system message after the conversation started is reported as hoisted', () => {
  expect(droppedParams(req({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be terse' },
    ],
  }))).toContain('system_message_hoisted')

  expect(droppedParams(req({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  }))).not.toContain('system_message_hoisted')
})

test('a tool message with no resolvable call id is reported', () => {
  expect(droppedParams(req({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ],
  }))).toContain('unmatched_tool_call_id')
})

test('tool arguments that are not a JSON object are reported', () => {
  expect(droppedParams(req({
    messages: [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'not json' } }],
    }],
  }))).toContain('malformed_tool_arguments')
})

test('a content part that is neither text nor an image is reported', () => {
  expect(droppedParams(req({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'watch' },
        { type: 'video_url', video_url: { url: 'https://v.test/a.mp4' } },
      ],
    }],
  }))).toContain('unsupported_content_part')
})

test('an image content part on a non-user message is reported, since only user turns carry images across', () => {
  expect(droppedParams(req({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'here' },
        { type: 'image_url', image_url: { url: 'https://i.test/a.png' } },
      ],
    }],
  }))).toContain('unsupported_content_part')
})

test('a strict tool schema is reported, since the Messages tools carry no such flag here', () => {
  expect(droppedParams(req({
    tools: [{
      type: 'function',
      function: { name: 'f', parameters: { type: 'object' }, strict: true },
    }],
  }))).toContain('strict_tool_schema')
})

test('reasoning_effort is not dropped — the translator carries it as thinking', () => {
  expect(droppedParams(req({ reasoning_effort: 'high' }))).not.toContain('reasoning_effort')
})
