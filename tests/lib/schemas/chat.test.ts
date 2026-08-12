import { expect, test } from 'vitest'
import { chatCompletionRequestSchema } from '@/lib/schemas/chat'

const minimal = { model: 'fast', messages: [{ role: 'user', content: 'hi' }] }

test('accepts a minimal request', () => {
  const parsed = chatCompletionRequestSchema.parse(minimal)
  expect(parsed.model).toBe('fast')
  expect(parsed.stream).toBeUndefined()
})

test('rejects a request with no model', () => {
  expect(() =>
    chatCompletionRequestSchema.parse({ messages: [{ role: 'user', content: 'hi' }] }),
  ).toThrow()
})

test('rejects an empty messages array', () => {
  expect(() =>
    chatCompletionRequestSchema.parse({ model: 'fast', messages: [] }),
  ).toThrow()
})

test('accepts multimodal content parts', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
      ],
    }],
  })
  expect(Array.isArray(parsed.messages[0].content)).toBe(true)
})

test('accepts tools, tool_choice, and an assistant tool_calls turn', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
    tool_choice: 'auto',
  })
  expect(parsed.tools?.[0].function.name).toBe('get_weather')
})

test('accepts a named tool_choice', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  })
  expect(parsed.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
})

test('preserves unknown provider-specific parameters', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    search_parameters: { mode: 'auto' },
  }) as Record<string, unknown>
  expect(parsed.search_parameters).toEqual({ mode: 'auto' })
})

test('accepts streaming with usage requested', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    stream: true,
    stream_options: { include_usage: true },
  })
  expect(parsed.stream).toBe(true)
  expect(parsed.stream_options?.include_usage).toBe(true)
})

test('rejects a non-boolean stream flag', () => {
  expect(() =>
    chatCompletionRequestSchema.parse({ ...minimal, stream: 'yes' }),
  ).toThrow()
})

test('preserves unknown keys nested inside messages, content parts, tool calls, and stream_options', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
        vendor_hint: 'x',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'f', arguments: '{}', vendor_arg_meta: 1 },
        }],
      },
    ],
    stream: true,
    stream_options: { include_usage: true, vendor_flag: true },
  }) as Record<string, never>

  const [first, second] = parsed.messages
  expect(first.vendor_hint).toBe('x')
  expect(first.content[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(second.tool_calls[0].function.vendor_arg_meta).toBe(1)
  expect(parsed.stream_options.vendor_flag).toBe(true)
})

test('preserves an unrecognized content part type', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } }],
    }],
  }) as Record<string, never>

  expect(parsed.messages[0].content[0]).toEqual({
    type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' },
  })
})

test('accepts the legacy function role', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [{ role: 'function', name: 'get_weather', content: '18C' }],
  })
  expect(parsed.messages[0].role).toBe('function')
})
