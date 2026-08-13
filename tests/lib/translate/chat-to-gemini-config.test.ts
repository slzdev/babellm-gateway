import { expect, test } from 'vitest'
import { droppedParams, toGeminiRequest } from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const base: ChatCompletionRequest = {
  model: 'virtual',
  messages: [{ role: 'user', content: 'hi' }],
}

function config(req: Partial<ChatCompletionRequest>) {
  return toGeminiRequest({ ...base, ...req }, 'gemini-2.5-flash').config ?? {}
}

test('the upstream model name replaces the virtual one', () => {
  expect(toGeminiRequest(base, 'gemini-2.5-flash').model).toBe('gemini-2.5-flash')
})

test('sampling parameters are renamed rather than dropped', () => {
  expect(config({
    temperature: 0.4,
    top_p: 0.9,
    seed: 7,
    stop: ['STOP'],
    max_tokens: 128,
  })).toMatchObject({
    temperature: 0.4,
    topP: 0.9,
    seed: 7,
    stopSequences: ['STOP'],
    maxOutputTokens: 128,
  })
})

test('max_completion_tokens wins over max_tokens', () => {
  expect(config({ max_tokens: 128, max_completion_tokens: 256 }).maxOutputTokens).toBe(256)
})

test('a bare string stop becomes a one-element stopSequences', () => {
  expect(config({ stop: 'END' }).stopSequences).toEqual(['END'])
})

test('penalties map to their camelCase names', () => {
  expect(config({ frequency_penalty: 0.5, presence_penalty: -0.2 } as Partial<ChatCompletionRequest>))
    .toMatchObject({ frequencyPenalty: 0.5, presencePenalty: -0.2 })
})

test('n of 1 sends no candidateCount at all', () => {
  expect(config({ n: 1 })).not.toHaveProperty('candidateCount')
})

test('n above 1 becomes candidateCount', () => {
  expect(config({ n: 3 }).candidateCount).toBe(3)
})

test('tools become function declarations with their JSON schema verbatim', () => {
  const parameters = { type: 'object', properties: { city: { type: 'string' } } }
  expect(config({
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters } }],
  }).tools).toEqual([{
    functionDeclarations: [{
      name: 'get_weather',
      description: 'weather',
      parametersJsonSchema: parameters,
    }],
  }])
})

test.each([
  ['none', 'NONE'],
  ['auto', 'AUTO'],
  ['required', 'ANY'],
] as const)('tool_choice %s maps to mode %s', (choice, mode) => {
  expect(config({ tool_choice: choice }).toolConfig)
    .toEqual({ functionCallingConfig: { mode } })
})

test('a named tool_choice constrains the allowed function names', () => {
  expect(config({ tool_choice: { type: 'function', function: { name: 'get_weather' } } }).toolConfig)
    .toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } })
})

test('json_object response format asks for a JSON mime type', () => {
  expect(config({ response_format: { type: 'json_object' } }).responseMimeType)
    .toBe('application/json')
})

test('json_schema response format carries the schema too', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
  expect(config({
    response_format: { type: 'json_schema', json_schema: { name: 'r', schema } },
  } as Partial<ChatCompletionRequest>)).toMatchObject({
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
  })
})

test('a text response format asks for nothing', () => {
  expect(config({ response_format: { type: 'text' } })).not.toHaveProperty('responseMimeType')
})

test.each([
  ['minimal', 'MINIMAL'],
  ['low', 'LOW'],
  ['medium', 'MEDIUM'],
  ['high', 'HIGH'],
] as const)('reasoning_effort %s maps to thinking level %s', (effort, level) => {
  expect(config({ reasoning_effort: effort }).thinkingConfig)
    .toEqual({ includeThoughts: true, thinkingLevel: level })
})

test('no reasoning_effort means no thinking config', () => {
  expect(config({})).not.toHaveProperty('thinkingConfig')
})

test('an unknown reasoning_effort asks for no thinking config', () => {
  expect(config({ reasoning_effort: 'turbo' })).not.toHaveProperty('thinkingConfig')
})

test('requestReasoningSummary asks for thoughts without a level', () => {
  const result = toGeminiRequest(base, 'gemini-2.5-flash', new Map(), {
    requestReasoningSummary: true,
  })
  expect(result.config?.thinkingConfig).toEqual({ includeThoughts: true })
})

test('the system instruction reaches the config', () => {
  const result = toGeminiRequest(
    { ...base, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
    'gemini-2.5-flash',
  )
  expect(result.config?.systemInstruction).toBe('be terse')
})

test('a request with nothing to configure still carries contents', () => {
  const result = toGeminiRequest(base, 'gemini-2.5-flash')
  expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
})

test('unmappable parameters are reported', () => {
  expect(droppedParams({
    ...base,
    logit_bias: { '1': 2 },
    logprobs: true,
    top_logprobs: 3,
    parallel_tool_calls: false,
    user: 'u-1',
  } as ChatCompletionRequest).sort())
    .toEqual(['logit_bias', 'logprobs', 'parallel_tool_calls', 'top_logprobs', 'user'])
})

test('values that mean the default are not reported', () => {
  expect(droppedParams({
    ...base,
    logit_bias: {},
    logprobs: false,
    parallel_tool_calls: true,
    user: '',
  } as ChatCompletionRequest)).toEqual([])
})

test('a leading system message is not reported as hoisted', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
  })).toEqual([])
})

test('a system message after a user turn is reported as hoisted', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }],
  })).toEqual(['system_message_hoisted'])
})

test('an uncorrelated tool result is reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'tool', tool_call_id: 'nope', content: 'x' }],
  })).toEqual(['unmatched_tool_call_id'])
})

test('an unnamed legacy function message is reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'function', content: 'x' }],
  } as ChatCompletionRequest)).toEqual(['unnamed_function_message'])
})

test('a named legacy function message is not reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'function', name: 'get_weather', content: 'x' }],
  } as ChatCompletionRequest)).toEqual([])
})

test('malformed tool call arguments are reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'nope' } }],
    }],
  })).toEqual(['malformed_tool_arguments'])
})

test('a content part Gemini cannot carry is reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }],
  } as ChatCompletionRequest)).toEqual(['unsupported_content_part'])
})

test('an unknown reasoning_effort is reported', () => {
  expect(droppedParams({ ...base, reasoning_effort: 'turbo' })).toEqual(['reasoning_effort'])
})

test('a known reasoning_effort is not reported', () => {
  expect(droppedParams({ ...base, reasoning_effort: 'high' })).toEqual([])
})
