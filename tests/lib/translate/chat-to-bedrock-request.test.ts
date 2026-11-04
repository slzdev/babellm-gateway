import { expect, test } from 'vitest'
import { droppedParams, toConverseRequest } from '@/lib/translate/chat-to-bedrock'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const base: ChatCompletionRequest = { model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }
const tool = { type: 'function' as const, function: { name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }

test('hoists system and developer text without demoting authority', () => {
  expect(toConverseRequest({ ...base, messages: [
    { role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' },
    { role: 'developer', content: [{ type: 'text', text: 'More rules' }] },
  ] }, 'arn:aws:bedrock:eu-west-1:123:inference-profile/test')).toEqual({
    modelId: 'arn:aws:bedrock:eu-west-1:123:inference-profile/test',
    system: [{ text: 'Rules' }, { text: 'More rules' }],
    messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
  })
})

test('preserves tool IDs and arguments and combines adjacent tool results', () => {
  const result = toConverseRequest({ ...base, tools: [tool], messages: [
    { role: 'assistant', content: 'Checking', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } },
      { id: 'b', type: 'function', function: { name: 'clock', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'Sunny' },
    { role: 'function', name: 'clock', content: '12:00' },
    { role: 'user', content: 'Thanks' },
  ] }, 'model')
  expect(result.messages).toEqual([
    { role: 'assistant', content: [{ text: 'Checking' },
      { toolUse: { toolUseId: 'a', name: 'weather', input: { city: 'Paris' } } },
      { toolUse: { toolUseId: 'b', name: 'clock', input: {} } },
    ] },
    { role: 'user', content: [
      { toolResult: { toolUseId: 'a', content: [{ text: 'Sunny' }] } },
      { toolResult: { toolUseId: 'b', content: [{ text: '12:00' }] } },
      { text: 'Thanks' },
    ] },
  ])
})

test.each(['{broken', '[]', 'null', '"value"'])('rejects tool input %s rather than silently replacing it', (arguments_) => {
  expect(() => toConverseRequest({ ...base, messages: [{ role: 'assistant', tool_calls: [
    { id: 'a', type: 'function', function: { name: 'f', arguments: arguments_ } },
  ] }] }, 'model')).toThrow(expect.objectContaining({ status: 400, param: 'messages[0].tool_calls[0].function.arguments' }))
})

test.each([
  ['auto', { auto: {} }], ['required', { any: {} }],
  [{ type: 'function', function: { name: 'weather' } }, { tool: { name: 'weather' } }],
] as const)('maps tool choice %j to Converse', (choice, expected) => {
  const result = toConverseRequest({ ...base, tools: [tool], tool_choice: choice }, 'model')
  expect(result.toolConfig).toEqual({
    tools: [{ toolSpec: { name: 'weather', description: 'Get weather', inputSchema: { json: tool.function.parameters } } }],
    toolChoice: expected,
  })
})

test('none withholds tools and omitted choice does not force a mode', () => {
  expect(toConverseRequest({ ...base, tools: [tool], tool_choice: 'none' }, 'model').toolConfig).toBeUndefined()
  expect(toConverseRequest({ ...base, tools: [tool] }, 'model').toolConfig?.toolChoice).toBeUndefined()
})

test('maps inference settings with max_completion_tokens precedence and null omission', () => {
  expect(toConverseRequest({ ...base, max_completion_tokens: 12, max_tokens: 30, temperature: 0, top_p: 0.9, stop: ['END', ''] }, 'm').inferenceConfig)
    .toEqual({ maxTokens: 12, temperature: 0, topP: 0.9, stopSequences: ['END'] })
  expect(toConverseRequest({ ...base, max_completion_tokens: null, max_tokens: 30, temperature: null, top_p: null, stop: null }, 'm').inferenceConfig)
    .toEqual({ maxTokens: 30 })
  expect(toConverseRequest(base, 'm').inferenceConfig).toBeUndefined()
})

test.each(['png', 'jpeg', 'gif', 'webp'])('decodes inline %s into SDK bytes', (format) => {
  const result = toConverseRequest({ ...base, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/${format};base64,AQID` } },
  ] }] }, 'm')
  expect(result.messages?.[0].content).toEqual([{ image: { format, source: { bytes: new Uint8Array([1, 2, 3]) } } }])
})

test.each(['data:image/png;base64,!!!!', 'data:image/png;base64,A', 'data:image/png;base64,', 'data:image/png,hello'])('invalid inline image fails with its field (%s)', (url) => {
  expect(() => toConverseRequest({ ...base, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url } },
  ] }] }, 'm')).toThrow(expect.objectContaining({ status: 400, param: 'messages[0].content[0].image_url.url' }))
})

test('drops remote and unsupported media while retaining text and reporting degradation', () => {
  const req: ChatCompletionRequest = { ...base, messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe' },
    { type: 'image_url', image_url: { url: 'https://example.com/private.png?secret=token' } },
    { type: 'image_url', image_url: { url: 'data:image/tiff;base64,AQID' } },
    { type: 'video_url', video_url: { url: 'https://example.com/video.mp4' } },
  ] }] }
  expect(toConverseRequest(req, 'm').messages).toEqual([{ role: 'user', content: [{ text: 'Describe' }] }])
  expect(droppedParams(req)).toContain('unsupported_content_part')
})

test('reports unsupported known and unknown fields and unsigned reasoning replay', () => {
  const req: ChatCompletionRequest = { ...base, reasoning_effort: 'high', response_format: { type: 'json_object' },
    seed: 2, parallel_tool_calls: false, user: 'alice', service_tier: 'priority', custom_vendor_option: true,
    tools: [{ ...tool, function: { ...tool.function, strict: true } }],
    messages: [{ role: 'assistant', content: 'Hello', reasoning_content: 'Unsigned thought' },
      { role: 'developer', content: 'Late rules' }, { role: 'tool', tool_call_id: 'missing', content: 'Result' }],
  }
  expect(droppedParams(req)).toEqual(expect.arrayContaining([
    'reasoning_effort', 'response_format', 'seed', 'parallel_tool_calls', 'user', 'service_tier',
    'custom_vendor_option', 'strict_tool_schema', 'reasoning_content', 'system_message_hoisted', 'unmatched_tool_call_id',
  ]))
  const result = toConverseRequest(req, 'm')
  expect(result.additionalModelRequestFields).toBeUndefined()
  expect(result.messages?.[0].content).toEqual([{ text: 'Hello' }])
  expect(result.messages?.[1].content).toEqual([{ text: '[tool result] Result' }])
})

test('does not report omitted or inert defaults as dropped', () => {
  expect(droppedParams({ ...base, n: 1, logprobs: false, seed: null, custom: {}, extra: [] })).toEqual([])
})

// These cases catch native history being sent without the toolConfig required
// by Converse, and preserve both sides of parallel historical tool calls.
test.each(['none', 'omitted', 'empty'] as const)('lowers completed multi-call history to historical data when tools are %s', (mode) => {
  const settings: Pick<ChatCompletionRequest, 'tools' | 'tool_choice'> = mode === 'none'
    ? { tools: [tool], tool_choice: 'none' } : mode === 'empty' ? { tools: [] } : {}
  const req: ChatCompletionRequest = { ...base, ...settings, messages: [
    { role: 'user', content: 'Check both cities' },
    { role: 'assistant', content: 'Checking', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'weather', arguments: '{ "city": "Paris" }' } },
      { id: 'b', type: 'function', function: { name: 'weather', arguments: '{"city":"Lyon"}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'Sunny' },
    { role: 'function', name: 'weather', content: 'Cloudy' },
    { role: 'user', content: 'Summarize the results' },
  ] }
  const result = toConverseRequest(req, 'model')
  expect(result.toolConfig).toBeUndefined()
  expect(result.messages).toEqual([
    { role: 'user', content: [{ text: 'Check both cities' }] },
    { role: 'assistant', content: [
      { text: 'Checking' },
      { text: '[historical tool call] {"id":"a","name":"weather","arguments":{"city":"Paris"}}' },
      { text: '[historical tool call] {"id":"b","name":"weather","arguments":{"city":"Lyon"}}' },
    ] },
    { role: 'user', content: [
      { text: '[historical tool result] {"id":"a","name":"weather","output":"Sunny"}' },
      { text: '[historical tool result] {"id":"b","name":"weather","output":"Cloudy"}' },
      { text: 'Summarize the results' },
    ] },
  ])
  expect(droppedParams(req)).toEqual(['tool_history'])
})

test.each(['', null, undefined])('preserves empty native tool output %j as explicit JSON', (content) => {
  const req: ChatCompletionRequest = { ...base, tools: [tool], messages: [
    { role: 'assistant', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'weather', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content },
  ] }
  const result = toConverseRequest(req, 'model')
  expect(result.toolConfig?.tools).toHaveLength(1)
  expect(result.messages).toEqual([
    { role: 'assistant', content: [{ toolUse: { toolUseId: 'a', name: 'weather', input: {} } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 'a', content: [{ json: { output: '' } }] } }] },
  ])
  expect(droppedParams(req)).toEqual([])
})
