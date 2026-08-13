import { expect, test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { fromGenerateContent } from '@/lib/translate/chat-to-gemini'

function response(partial: Record<string, unknown>): GenerateContentResponse {
  // GenerateContentResponse is a class with derived accessors (text, data,
  // functionCalls, ...) that a plain fixture object never has, so tsc rejects
  // a direct cast as insufficiently overlapping. The fixtures here only ever
  // exercise the plain data fields fromGenerateContent reads.
  return partial as unknown as GenerateContentResponse
}

test('text parts become the assistant message content', () => {
  const result = fromGenerateContent(
    response({
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [{
        content: { role: 'model', parts: [{ text: 'hello ' }, { text: 'world' }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.model).toBe('gemini-2.5-flash-001')
  expect(result.choices[0].message.content).toBe('hello world')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('the upstream model name is used when the response does not name one', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.model).toBe('gemini-2.5-flash')
})

test('thought parts become reasoning_content, not content', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ text: 'thinking', thought: true }, { text: 'answer' }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-pro',
  )

  // reasoning_content is non-standard and absent from the OpenAI SDK's
  // ChatCompletionMessage type, so go through `unknown` rather than a direct cast.
  const message = result.choices[0].message as unknown as {
    content: string
    reasoning_content?: string
  }
  expect(message.content).toBe('answer')
  expect(message.reasoning_content).toBe('thinking')
})

test('a text-free response reports null content rather than an empty string', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].message.content).toBeNull()
})

test('function calls become tool_calls and force a tool_calls finish reason', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices[0].message.tool_calls).toEqual([{
    id: 'call_0_0',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('a function call that finished MAX_TOKENS reports length, not tool_calls', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        finishReason: 'MAX_TOKENS',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices[0].message.tool_calls).toHaveLength(1)
  expect(result.choices[0].finish_reason).toBe('length')
})

test('a function call that finished on a content-filter reason reports content_filter, not tool_calls', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        finishReason: 'SAFETY',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices[0].message.tool_calls).toHaveLength(1)
  expect(result.choices[0].finish_reason).toBe('content_filter')
})

test('a function call id from the provider is preferred over a synthesized one', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { id: 'upstream-1', name: 'f', args: {} } }] },
      }],
    }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].message.tool_calls?.[0].id).toBe('upstream-1')
})

test.each([
  ['MAX_TOKENS', 'length'],
  ['SAFETY', 'content_filter'],
  ['PROHIBITED_CONTENT', 'content_filter'],
  ['BLOCKLIST', 'content_filter'],
  ['SPII', 'content_filter'],
  ['IMAGE_SAFETY', 'content_filter'],
  ['RECITATION', 'content_filter'],
  ['STOP', 'stop'],
  ['OTHER', 'stop'],
  ['MALFORMED_FUNCTION_CALL', 'stop'],
] as const)('finish reason %s maps to %s', (reason, expected) => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].finish_reason).toBe(expected)
})

test('a blocked prompt becomes one empty content_filter choice, not an error', () => {
  const result = fromGenerateContent(
    response({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    'gemini-2.5-flash',
  )

  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.content).toBeNull()
  expect(result.choices[0].finish_reason).toBe('content_filter')
})

test('multiple candidates become multiple choices at their own indices', () => {
  const result = fromGenerateContent(
    response({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] }, finishReason: 'STOP' },
        { index: 1, content: { parts: [{ text: 'two' }] }, finishReason: 'STOP' },
      ],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices.map((c) => [c.index, c.message.content]))
    .toEqual([[0, 'one'], [1, 'two']])
})

test('completion tokens include thoughts, which are also reported separately', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 6,
        totalTokenCount: 20,
        cachedContentTokenCount: 3,
      },
    }),
    'gemini-2.5-pro',
  )

  expect(result.usage).toMatchObject({
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 6 },
    prompt_tokens_details: { cached_tokens: 3 },
  })
})

test('usage with no thoughts reports no reasoning token details', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
    'gemini-2.5-flash',
  )

  expect(result.usage?.completion_tokens).toBe(3)
  expect(result.usage).not.toHaveProperty('completion_tokens_details')
})

test('a response with no usage metadata reports no usage', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.usage).toBeUndefined()
})
