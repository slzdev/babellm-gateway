import { expect, test } from 'vitest'
import { toMessagesRequest } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function req(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'virtual',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

test('system and developer messages hoist to the top-level system parameter', () => {
  const out = toMessagesRequest(req({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'developer', content: 'and precise' },
      { role: 'user', content: 'hi' },
    ],
  }), 'claude-opus-5')

  expect(out.system).toBe('be terse\n\nand precise')
  expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('max_tokens falls back through the client, the catalog, then the constant', () => {
  expect(toMessagesRequest(req({ max_tokens: 10 }), 'm').max_tokens).toBe(10)
  expect(toMessagesRequest(req({ max_completion_tokens: 20, max_tokens: 10 }), 'm').max_tokens).toBe(20)
  expect(toMessagesRequest(req(), 'm', {}, 64000).max_tokens).toBe(64000)
  expect(toMessagesRequest(req(), 'm', {}, null).max_tokens).toBe(4096)
})

test('an http image becomes a url source and a data url becomes a base64 source', () => {
  const out = toMessagesRequest(req({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'https://img.test/a.png' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    }],
  }), 'm')

  expect(out.messages[0].content).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'url', url: 'https://img.test/a.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
  ])
})

test('assistant tool calls become tool_use and tool messages become tool_result', () => {
  const out = toMessagesRequest(req({
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C' },
    ],
  }), 'm')

  expect(out.messages[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
  })
  expect(out.messages[2]).toEqual({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '18C' }],
  })
})

test('tools, tool_choice and parallel_tool_calls map onto the Messages shapes', () => {
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Look up weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }]

  expect(toMessagesRequest(req({ tools }), 'm').tools).toEqual([{
    name: 'get_weather',
    description: 'Look up weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
  }])

  expect(toMessagesRequest(req({ tools, tool_choice: 'required' }), 'm').tool_choice)
    .toEqual({ type: 'any' })
  expect(toMessagesRequest(req({ tools, tool_choice: 'none' }), 'm').tool_choice)
    .toEqual({ type: 'none' })
  expect(toMessagesRequest(req({
    tools, tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }), 'm').tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  expect(toMessagesRequest(req({ tools, parallel_tool_calls: false }), 'm').tool_choice)
    .toEqual({ type: 'auto', disable_parallel_tool_use: true })
})

test('sampling, stop sequences and the user identifier carry across', () => {
  const out = toMessagesRequest(req({
    temperature: 0.2, top_p: 0.9, stop: ['STOP', ''], user: 'u-1',
  }), 'm')

  expect(out.temperature).toBe(0.2)
  expect(out.top_p).toBe(0.9)
  expect(out.stop_sequences).toEqual(['STOP'])
  expect(out.metadata).toEqual({ user_id: 'u-1' })
})

test('thinking is asked for only when the client or the provider asked for it', () => {
  expect(toMessagesRequest(req(), 'm').thinking).toBeUndefined()

  const asked = toMessagesRequest(req({ reasoning_effort: 'high' }), 'm')
  expect(asked.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect((asked as { output_config?: unknown }).output_config).toEqual({ effort: 'high' })

  const byConfig = toMessagesRequest(req(), 'm', { requestReasoningSummary: true })
  expect(byConfig.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect((byConfig as { output_config?: unknown }).output_config).toBeUndefined()
})

test('effort maps OpenAI vocabulary and forwards anything else verbatim', () => {
  const effortOf = (effort: string) =>
    (toMessagesRequest(req({ reasoning_effort: effort }), 'm') as {
      output_config?: { effort?: string }
    }).output_config?.effort

  expect(effortOf('minimal')).toBe('low')
  expect(effortOf('medium')).toBe('medium')
  expect(effortOf('xhigh')).toBe('xhigh')

  const none = toMessagesRequest(req({ reasoning_effort: 'none' }), 'm')
  expect(none.thinking).toBeUndefined()
  expect((none as { output_config?: unknown }).output_config).toBeUndefined()
})

test('budget_tokens is never sent', () => {
  const out = toMessagesRequest(req({ reasoning_effort: 'high' }), 'm')
  expect(JSON.stringify(out)).not.toContain('budget_tokens')
})
