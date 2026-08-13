import { expect, test } from 'vitest'
import { droppedParams, toResponsesRequest } from '@/lib/translate/chat-to-responses'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'house-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

test('substitutes the upstream model and pins store to false', () => {
  const params = toResponsesRequest(request(), 'gpt-5-mini')
  expect(params.model).toBe('gpt-5-mini')
  expect(params.store).toBe(false)
})

test('system and developer messages keep their role and position', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'use json' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'developer', content: 'use json' },
  ])
})

test('content parts become input_text and input_image', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'low' } },
        ],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([{
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'low' },
    ],
  }])
})

test('an image without a detail defaults to auto', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
      }],
    }),
    'm',
  )

  expect((params.input as never[])[0]).toMatchObject({
    content: [{ type: 'input_image', detail: 'auto' }],
  })
})

test('assistant tool calls become function_call items carrying the call id', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'user', content: 'weather?' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ])
})

test('an assistant message with both text and tool calls emits both, text first', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{
          id: 'call_9', type: 'function',
          function: { name: 'f', arguments: '{}' },
        }],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'assistant', content: 'let me check' },
    { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{}' },
  ])
})

test('a legacy function message is carried as text rather than a dangling call_id', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'function', name: 'get_weather', content: '18C' },
      ],
    } as never),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'user', content: 'weather?' },
    { role: 'developer', content: '[function result: get_weather] 18C' },
  ])
})

test('no function_call_output is emitted for a legacy function message', () => {
  const params = toResponsesRequest(
    request({ messages: [{ role: 'function', name: 'f', content: 'x' }] } as never),
    'm',
  )
  const items = params.input as { type?: string }[]
  expect(items.some((item) => item.type === 'function_call_output')).toBe(false)
})

test('droppedParams reports a legacy function message', () => {
  expect(
    droppedParams(request({
      messages: [{ role: 'function', name: 'f', content: 'x' }],
    } as never)),
  ).toEqual(['legacy_function_message'])
})

test('a modern tool message still becomes function_call_output', () => {
  const params = toResponsesRequest(
    request({
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' }],
    } as never),
    'm',
  )

  expect(params.input).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ])
})

test('tools flatten out of their function wrapper', () => {
  const params = toResponsesRequest(
    request({
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'look up weather',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      }],
    }),
    'm',
  )

  expect(params.tools).toEqual([{
    type: 'function',
    name: 'get_weather',
    description: 'look up weather',
    parameters: { type: 'object', properties: {} },
    strict: true,
  }])
})

test('a named tool_choice flattens the same way', () => {
  const params = toResponsesRequest(
    request({ tool_choice: { type: 'function', function: { name: 'f' } } }),
    'm',
  )
  expect(params.tool_choice).toEqual({ type: 'function', name: 'f' })
})

test('a string tool_choice passes through', () => {
  expect(toResponsesRequest(request({ tool_choice: 'required' }), 'm').tool_choice)
    .toBe('required')
})

test('max_completion_tokens wins over max_tokens', () => {
  const params = toResponsesRequest(
    request({ max_tokens: 10, max_completion_tokens: 99 }),
    'm',
  )
  expect(params.max_output_tokens).toBe(99)
})

test('max_tokens is used when max_completion_tokens is absent', () => {
  expect(toResponsesRequest(request({ max_tokens: 10 }), 'm').max_output_tokens).toBe(10)
})

test('a json_schema response format flattens into text.format', () => {
  const params = toResponsesRequest(
    request({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    } as never),
    'm',
  )

  expect(params.text).toEqual({
    format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
  })
})

test('a json_object response format maps to text.format', () => {
  const params = toResponsesRequest(
    request({ response_format: { type: 'json_object' } }),
    'm',
  )
  expect(params.text).toEqual({ format: { type: 'json_object' } })
})

test('user maps to safety_identifier', () => {
  expect(toResponsesRequest(request({ user: 'u-1' }), 'm').safety_identifier).toBe('u-1')
})

test('reasoning is not requested when the client gave no reasoning_effort', () => {
  expect(toResponsesRequest(request(), 'm').reasoning).toBeUndefined()
})

test('reasoning_effort asks for a summary alongside the effort', () => {
  const params = toResponsesRequest(request({ reasoning_effort: 'high' } as never), 'm')
  expect(params.reasoning).toEqual({ effort: 'high', summary: 'auto' })
})

test('the provider config can request summaries without a client hint', () => {
  const params = toResponsesRequest(request(), 'm', { requestReasoningSummary: true })
  expect(params.reasoning).toEqual({ summary: 'auto' })
})

test('unmappable parameters never appear in the upstream request', () => {
  const params = toResponsesRequest(
    request({ n: 3, stop: ['\n'], seed: 7, frequency_penalty: 0.5 } as never),
    'm',
  )

  for (const key of ['n', 'stop', 'seed', 'frequency_penalty']) {
    expect(params).not.toHaveProperty(key)
  }
})

test('droppedParams names the parameters that were discarded', () => {
  expect(droppedParams(request({ n: 3, stop: ['\n'], seed: 7 } as never)).sort())
    .toEqual(['n', 'seed', 'stop'])
})

test('droppedParams stays silent about inert defaults', () => {
  expect(droppedParams(request({
    n: 1, frequency_penalty: 0, presence_penalty: 0, temperature: 0.7,
  } as never))).toEqual([])
})

test('droppedParams reports audio content parts', () => {
  const dropped = droppedParams(request({
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }],
    }],
  } as never))

  expect(dropped).toContain('audio_content')
})

test('a request with nothing unmappable drops nothing', () => {
  expect(droppedParams(request({ temperature: 0.2, top_p: 1 }))).toEqual([])
})
