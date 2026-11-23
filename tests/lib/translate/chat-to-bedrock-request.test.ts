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
  expect(droppedParams(req, 'm')).toContain('unsupported_content_part')
})

test('reports unsupported known and unknown fields and unsigned reasoning replay', () => {
  const req: ChatCompletionRequest = { ...base, reasoning_effort: 'high', response_format: { type: 'json_object' },
    seed: 2, parallel_tool_calls: false, user: 'alice', service_tier: 'priority', custom_vendor_option: true,
    tools: [{ ...tool, function: { ...tool.function, strict: true } }],
    messages: [{ role: 'assistant', content: 'Hello', reasoning_content: 'Unsigned thought' },
      { role: 'developer', content: 'Late rules' }, { role: 'tool', tool_call_id: 'missing', content: 'Result' }],
  }
  expect(droppedParams(req, 'm')).toEqual(expect.arrayContaining([
    'reasoning_effort', 'response_format', 'seed', 'parallel_tool_calls', 'user', 'service_tier',
    'custom_vendor_option', 'strict_tool_schema', 'reasoning_content', 'system_message_hoisted', 'unmatched_tool_call_id',
  ]))
  const result = toConverseRequest(req, 'm')
  expect(result.additionalModelRequestFields).toBeUndefined()
  expect(result.messages?.[0].content).toEqual([{ text: 'Hello' }])
  expect(result.messages?.[1].content).toEqual([{ text: '[tool result] Result' }])
})

test('does not report omitted or inert defaults as dropped', () => {
  expect(droppedParams({ ...base, n: 1, logprobs: false, seed: null, custom: {}, extra: [] }, 'm')).toEqual([])
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
  expect(droppedParams(req, 'm')).toEqual(['tool_history'])
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
  expect(droppedParams(req, 'm')).toEqual([])
})

const AUTO = { cache_control: { type: 'ephemeral' } }

test.each([
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-7',
  'eu.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'us.anthropic.claude-opus-5-5',
  'jp.anthropic.claude-sonnet-5',
  'us.anthropic.claude-sonnet-5-5',
  'anthropic.claude-haiku-5-5',
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6',
  'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-5',
])('enables automatic prompt caching for %s', (model) => {
  const result = toConverseRequest({ ...base, messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' }] }, model)
  expect(result.additionalModelRequestFields).toEqual(AUTO)
  // Automatic mode places its own checkpoint; explicit ones would compete for the 4 slots.
  expect(JSON.stringify(result)).not.toContain('cachePoint')
})

test.each([
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-fable-5',
  'anthropic.claude-fable-5-2',
  'anthropic.claude-mythos-5-1',
])('places explicit cache checkpoints for %s, which lacks automatic mode', (model) => {
  const result = toConverseRequest({ ...base, messages: [
    { role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' },
  ] }, model)
  expect(result.additionalModelRequestFields).toBeUndefined()
  expect(result.system).toEqual([{ text: 'Rules' }, { cachePoint: { type: 'default' } }])
  expect(result.messages).toEqual([
    { role: 'user', content: [{ text: 'Hi' }] },
    { role: 'assistant', content: [{ text: 'Hello' }] },
    { role: 'user', content: [{ text: 'Again' }, { cachePoint: { type: 'default' } }] },
  ])
})

test('explicit checkpoints skip an absent system prompt', () => {
  const result = toConverseRequest(base, 'anthropic.claude-fable-5')
  expect(result.system).toBeUndefined()
  expect(result.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }, { cachePoint: { type: 'default' } }] }])
})

test.each([
  'model',
  'amazon.nova-pro-v1:0',
  'meta.llama3-70b-instruct-v1:0',
  'anthropic.claude-3-5-sonnet-20240620-v1:0',
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-opus-4-20250514-v1:0',
  'arn:aws:bedrock:eu-west-1:123:application-inference-profile/abc123',
])('leaves prompt caching off for %s', (model) => {
  const result = toConverseRequest({ ...base, messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' }] }, model)
  expect(result.additionalModelRequestFields).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('cachePoint')
})

test('reasoning effort merges with automatic cache', () => {
  const result = toConverseRequest({ ...base, reasoning_effort: 'high' }, 'anthropic.claude-sonnet-5-5')
  expect(result.additionalModelRequestFields).toEqual({
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
  })
})

test('legacy budget supplies maxTokens when the client sent none', () => {
  const result = toConverseRequest({ ...base, reasoning_effort: 'low' }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(result.inferenceConfig?.maxTokens).toBe(6144)
})

test('a client max wins over the reasoning-derived max', () => {
  const result = toConverseRequest({ ...base, reasoning_effort: 'low', max_tokens: 5000 }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(result.inferenceConfig?.maxTokens).toBe(5000)
})

test('openai models receive reasoning effort', () => {
  const result = toConverseRequest({ ...base, reasoning_effort: 'low' }, 'global.openai.gpt-6.1-terra')
  expect(result.additionalModelRequestFields).toEqual({ reasoning: { effort: 'low', summary: 'auto' } })
})

test('provider opt-in requests a reasoning summary without an effort', () => {
  const result = toConverseRequest(base, 'global.openai.gpt-6.1-terra', { requestReasoningSummary: true })
  expect(result.additionalModelRequestFields).toEqual({ reasoning: { summary: 'auto' } })
})

test('an unsupported family ignores reasoning_effort', () => {
  const model = 'meta.llama4-maverick-17b-instruct-v1:0'
  expect(toConverseRequest({ ...base, reasoning_effort: 'high' }, model)).toEqual(toConverseRequest(base, model))
})

test('droppedParams reports reasoning_effort only when it was not translated', () => {
  const req = { ...base, reasoning_effort: 'high' as const }
  expect(droppedParams(req, 'anthropic.claude-sonnet-5-5')).not.toContain('reasoning_effort')
  expect(droppedParams(req, 'global.openai.gpt-6.1-terra')).not.toContain('reasoning_effort')
  expect(droppedParams(req, 'meta.llama4-maverick-17b-instruct-v1:0')).toContain('reasoning_effort')
  expect(droppedParams({ ...req, max_tokens: 1000 }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toContain('reasoning_effort')
})

test('droppedParams reports reasoning_effort for legacy thinking in a tool loop', () => {
  const call = { id: 'c1', type: 'function' as const, function: { name: 'weather', arguments: '{}' } }
  const req: ChatCompletionRequest = { ...base, reasoning_effort: 'high', tools: [tool], messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
  ] }
  expect(droppedParams(req, 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toContain('reasoning_effort')
  expect(droppedParams(req, 'anthropic.claude-sonnet-5-5')).not.toContain('reasoning_effort')
})
