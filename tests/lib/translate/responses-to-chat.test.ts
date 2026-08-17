import { expect, test } from 'vitest'
import { assertServiceable, droppedParams, toChatRequest } from '@/lib/translate/responses-to-chat'

test('a bare string input becomes one user message', () => {
  expect(toChatRequest({ model: 'm', input: 'hi' }).messages)
    .toEqual([{ role: 'user', content: 'hi' }])
})

test('instructions become a leading system message', () => {
  const { messages } = toChatRequest({ model: 'm', input: 'hi', instructions: 'be terse' })

  expect(messages[0]).toEqual({ role: 'system', content: 'be terse' })
  expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
})

test('input_text and input_image become chat content parts', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'https://x/y.png' },
    ] }],
  })

  expect(messages[0].content).toEqual([
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: 'https://x/y.png' } },
  ])
})

test('an assistant output_text becomes assistant content', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] }],
  })

  expect(messages[0]).toEqual({ role: 'assistant', content: 'sure' })
})

test('a function_call becomes an assistant tool_call', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' }],
  })

  expect(messages[0]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
  })
})

test('consecutive function_calls collapse into one assistant message', () => {
  // Chat Completions represents a parallel call as several tool_calls on one
  // message; leaving them separate would read as two sequential turns.
  const { messages } = toChatRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
    ],
  })

  expect(messages).toHaveLength(1)
  expect(messages[0].tool_calls).toHaveLength(2)
})

test('a function_call_output becomes a tool message', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }],
  })

  expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'done' })
})

test('a reasoning item is dropped rather than fed back', () => {
  const req = { model: 'm', input: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] } as never

  expect(toChatRequest(req).messages).toHaveLength(1)
  expect(droppedParams(req)).toContain('input.reasoning')
})

test('tools are un-nested into the chat shape', () => {
  const { tools } = toChatRequest({
    model: 'm', input: 'hi',
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true }],
  })

  expect(tools).toEqual([{
    type: 'function',
    function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
  }])
})

test('a hosted tool never reaches the output as a malformed function tool', () => {
  // Chat Completions can express only function tools. assertServiceable
  // rejects a hosted tool before this module runs, but toTools must not emit
  // a structurally invalid {function: {name: undefined}} regardless.
  const { tools } = toChatRequest({
    model: 'm', input: 'hi',
    tools: [{ type: 'web_search' }, { type: 'function', name: 'f' }] as never,
  })

  expect(tools).toEqual([{ type: 'function', function: { name: 'f' } }])
})

test('a named tool_choice is un-nested too', () => {
  expect(toChatRequest({ model: 'm', input: 'hi', tool_choice: { type: 'function', name: 'f' } }).tool_choice)
    .toEqual({ type: 'function', function: { name: 'f' } })
})

test('text.format becomes response_format', () => {
  const req = { model: 'm', input: 'hi', text: { format: {
    type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true,
  } } }

  expect(toChatRequest(req).response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
  })
})

test('text.format type text sets no response_format at all', () => {
  expect(toChatRequest({ model: 'm', input: 'hi', text: { format: { type: 'text' } } }).response_format)
    .toBeUndefined()
})

test('the scalar parameters map by name', () => {
  const chat = toChatRequest({
    model: 'm', input: 'hi',
    max_output_tokens: 100, reasoning: { effort: 'high' },
    temperature: 0.5, top_p: 0.9, parallel_tool_calls: false, service_tier: 'flex', user: 'u1',
  })

  // max_completion_tokens rather than max_tokens: the latter is deprecated and
  // excludes reasoning tokens on reasoning models.
  expect(chat.max_completion_tokens).toBe(100)
  expect(chat.reasoning_effort).toBe('high')
  expect(chat).toMatchObject({ temperature: 0.5, top_p: 0.9, parallel_tool_calls: false, service_tier: 'flex', user: 'u1' })
})

test('reports the parameters Chat Completions cannot express', () => {
  const dropped = droppedParams({
    model: 'm', input: 'hi',
    truncation: 'auto', include: ['reasoning.encrypted_content'], store: true,
    metadata: { a: 'b' }, max_tool_calls: 3, prompt_cache_key: 'k',
    safety_identifier: 's', reasoning: { effort: 'high', summary: 'auto' },
  })

  expect(dropped.sort()).toEqual([
    'include', 'max_tool_calls', 'metadata', 'prompt_cache_key',
    'reasoning.summary', 'safety_identifier', 'store', 'truncation',
  ])
})

test('reports nothing for a request Chat Completions expresses fully', () => {
  expect(droppedParams({ model: 'm', input: 'hi', temperature: 0.5 })).toEqual([])
})

test('store: false is not reported, because it is what chat does anyway', () => {
  // Reporting an inert value would put a line in the header on nearly every
  // request and bury the ones that changed the answer.
  expect(droppedParams({ model: 'm', input: 'hi', store: false })).toEqual([])
})

test.each([
  'web_search', 'file_search', 'code_interpreter', 'image_generation', 'computer_use', 'mcp',
])('rejects the hosted tool %s by name', (type) => {
  // Dropping a hosted tool would answer the request wrongly rather than
  // approximately: the model cannot search, and says so as if it had.
  expect(() => assertServiceable({ model: 'm', input: 'hi', tools: [{ type }] }, 'p1'))
    .toThrow(new RegExp(`${type}.*p1`))
})

test('rejects an unknown, not-yet-invented tool type', () => {
  // The check is an inversion (reject anything that is not `function`), not a
  // deny-list of today's hosted tools: a type OpenAI ships tomorrow must be
  // caught by the same rule without this file ever being touched again.
  expect(() => assertServiceable({ model: 'm', input: 'hi', tools: [{ type: 'quantum_search' }] }, 'p1'))
    .toThrow(new RegExp('quantum_search.*p1'))
})

test('accepts a function tool', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', tools: [{ type: 'function', name: 'f' }] }, 'p1'))
    .not.toThrow()
})

test('rejects previous_response_id, which a chat provider cannot resolve', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', previous_response_id: 'resp_1' }, 'p1'))
    .toThrow(/previous_response_id/)
})

test('rejects conversation for the same reason', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', conversation: 'conv_1' }, 'p1'))
    .toThrow(/conversation/)
})

test('rejects an item_reference input item', () => {
  expect(() => assertServiceable({ model: 'm', input: [{ type: 'item_reference', id: 'msg_1' }] }, 'p1'))
    .toThrow(/item_reference/)
})

test('the rejection is a non-retryable 400', () => {
  // Non-retryable twice over: execute must not replay a doomed request against
  // every target, and recordHealth must not demote a target that is healthy.
  try {
    assertServiceable({ model: 'm', input: 'hi', tools: [{ type: 'web_search' }] }, 'p1')
    expect.unreachable()
  } catch (err) {
    expect(err).toMatchObject({ name: 'ProviderError', status: 400, retryable: false })
  }
})
