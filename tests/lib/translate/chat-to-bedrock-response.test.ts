import { expect, test } from 'vitest'
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime'
import { fromConverse } from '@/lib/translate/chat-to-bedrock'

// AWS Converse wire shape, including metadata and required metrics.
const fixture = {
  $metadata: { requestId: 'aws-request' }, metrics: { latencyMs: 20 },
  output: { message: { role: 'assistant', content: [
    { reasoningContent: { reasoningText: { text: 'Thinking', signature: 'signed' } } },
    { text: 'Hello' }, { text: ' world' },
    { toolUse: { toolUseId: 'a', name: 'weather', input: { city: 'Paris' } } },
  ] } }, stopReason: 'tool_use',
  usage: { inputTokens: 10, cacheReadInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4, totalTokens: 19 },
} satisfies ConverseCommandOutput

test('translates text, reasoning and tool calls with cache-aware usage', () => {
  const result = fromConverse(fixture, 'arn:upstream')
  expect(result).toMatchObject({ object: 'chat.completion', model: 'arn:upstream', choices: [{ index: 0,
    message: { role: 'assistant', content: 'Hello world', reasoning_content: 'Thinking',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
    }, finish_reason: 'tool_calls',
  }], usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } } })
  expect(result.usage?.completion_tokens_details).toBeUndefined()
})

test.each([
  ['end_turn', 'stop'], ['stop_sequence', 'stop'], ['tool_use', 'tool_calls'],
  ['max_tokens', 'length'], ['model_context_window_exceeded', 'length'],
  ['guardrail_intervened', 'content_filter'], ['content_filtered', 'content_filter'],
] as const)('maps documented stop reason %s', (stopReason, expected) => {
  expect(fromConverse({ ...fixture, stopReason, output: { message: { role: 'assistant', content: [{ text: 'ok' }] } } }, 'm').choices[0].finish_reason).toBe(expected)
})

test.each(['malformed_model_output', 'malformed_tool_use', 'new_unknown_reason', undefined])('does not invent success for stop reason %s', (stopReason) => {
  expect(() => fromConverse({ ...fixture, stopReason } as ConverseCommandOutput, 'm'))
    .toThrow(expect.objectContaining({ name: 'ProviderError', status: 502, retryable: true }))
})

test.each([
  undefined,
  { message: { role: 'user', content: [{ text: 'wrong role' }] } },
  { message: { role: 'assistant' } },
  { message: { role: 'assistant', content: [{ toolUse: { name: 'f', input: {} } }] } },
])('rejects missing or malformed output %j', (output) => {
  expect(() => fromConverse({ ...fixture, output } as ConverseCommandOutput, 'm')).toThrow(expect.objectContaining({ name: 'ProviderError' }))
})

test('missing or partial usage is omitted instead of fabricated as zero', () => {
  expect(fromConverse({ ...fixture, usage: undefined }, 'm').usage).toBeUndefined()
  expect(fromConverse({ ...fixture, usage: { inputTokens: 10 } } as ConverseCommandOutput, 'm').usage).toBeUndefined()
})

test('redacted reasoning is not emitted as text or invented reasoning usage', () => {
  const result = fromConverse({ ...fixture, output: { message: { role: 'assistant', content: [
    { reasoningContent: { redactedContent: new Uint8Array([1]) } }, { text: 'ok' },
  ] } } }, 'm')
  expect(result.choices[0].message).toEqual({ role: 'assistant', content: 'ok' })
})

test.each([null, {}, { text: 12 }, { toolUse: { toolUseId: 'a', name: 'f', input: [] } }])('classifies malformed content block %j as an upstream failure', (block) => {
  expect(() => fromConverse({ ...fixture, output: { message: { role: 'assistant', content: [block] } } } as ConverseCommandOutput, 'm'))
    .toThrow(expect.objectContaining({ name: 'ProviderError', retryable: true }))
})
