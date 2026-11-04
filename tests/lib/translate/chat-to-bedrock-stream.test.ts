import { expect, test } from 'vitest'
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import { fromConverseStream } from '@/lib/translate/chat-to-bedrock'

const req: ChatCompletionRequest = { model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }
async function* feed(events: unknown[]) { for (const event of events) yield event as ConverseStreamOutput }
async function collect(events: unknown[], request = req) {
  return Array.fromAsync(fromConverseStream(feed(events), request, 'upstream'))
}
const start = { messageStart: { role: 'assistant' } }
const stop = { messageStop: { stopReason: 'end_turn' } }
const metadata = { metadata: { usage: { inputTokens: 10, cacheReadInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4, totalTokens: 19 }, metrics: { latencyMs: 12 } } }

test('relays text and reasoning and reads usage after messageStop', async () => {
  // AWS text/reasoning blocks have deltas without a contentBlockStart.
  const chunks = await collect([start,
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Think' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'signed' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hello' } } },
    { contentBlockStop: { contentBlockIndex: 1 } }, stop, metadata,
  ])
  expect(chunks.flatMap((c) => c.choices).map((c) => c.delta)).toEqual([
    { role: 'assistant' }, { reasoning_content: 'Think' }, { content: 'Hello' }, {},
  ])
  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('stop')
  expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 15, completion_tokens: 4, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } })
})

test('tool indices are contiguous across interleaved text and preserve partial JSON', async () => {
  const chunks = await collect([start,
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Checking' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'a', name: 'weather' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"Paris"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'Also' } } },
    { contentBlockStop: { contentBlockIndex: 2 } },
    { contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: 'b', name: 'clock' } } } },
    { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: '{}' } } } },
    { contentBlockStop: { contentBlockIndex: 3 } },
    { messageStop: { stopReason: 'tool_use' } }, metadata,
  ])
  expect(chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])).toEqual([
    { index: 0, id: 'a', type: 'function', function: { name: 'weather', arguments: '' } },
    { index: 0, function: { arguments: '{"city":' } },
    { index: 0, function: { arguments: '"Paris"}' } },
    { index: 1, id: 'b', type: 'function', function: { name: 'clock', arguments: '' } },
    { index: 1, function: { arguments: '{}' } },
  ])
  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls')
})

test.each([
  ['end_turn', 'stop'], ['stop_sequence', 'stop'], ['tool_use', 'tool_calls'],
  ['max_tokens', 'length'], ['model_context_window_exceeded', 'length'],
  ['guardrail_intervened', 'content_filter'], ['content_filtered', 'content_filter'],
] as const)('maps stream stop reason %s', async (stopReason, expected) => {
  const toolEvents = stopReason === 'tool_use' ? [
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'a', name: 'weather' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
  ] : []
  const chunks = await collect([start, ...toolEvents, { messageStop: { stopReason } }])
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe(expected)
})

test.each([
  [], [start], [start, { messageStop: {} }], [start, { messageStop: { stopReason: 'unknown' } }],
  [start, { messageStop: { stopReason: 'malformed_model_output' } }],
  [start, { messageStop: { stopReason: 'malformed_tool_use' } }],
  [start, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'open block' } } }, stop],
  [start, { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } }, stop],
  [start, { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'a', name: 'f' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{bad' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } }, stop],
].map((events) => [events]))('rejects incomplete or malformed stream %#', async (events) => {
  await expect(collect(events)).rejects.toMatchObject({ name: 'ProviderError', status: 502, retryable: true })
})

test.each([
  ['internalServerException', 500, true], ['modelStreamErrorException', 424, true],
  ['serviceUnavailableException', 503, true], ['throttlingException', 429, true], ['validationException', 400, false],
] as const)('classifies stream %s even after messageStop', async (member, status, retryable) => {
  await expect(collect([start, stop, { [member]: { message: 'AWS failed' } }])).rejects.toMatchObject({ name: 'ProviderError', status, retryable })
})

test('propagates thrown iterator errors for the adapter classifier', async () => {
  const error = new Error('connection dropped')
  async function* broken() { yield start as ConverseStreamOutput; throw error }
  await expect(Array.fromAsync(fromConverseStream(broken(), req, 'm'))).rejects.toBe(error)
})

test('does not fabricate usage and honors explicit usage suppression', async () => {
  expect((await collect([start, stop])).some((c) => c.usage)).toBe(false)
  expect((await collect([start, stop, { metadata: { usage: { inputTokens: 2 }, metrics: { latencyMs: 1 } } }])).some((c) => c.usage)).toBe(false)
  expect((await collect([start, stop, metadata], { ...req, stream_options: { include_usage: false } })).some((c) => c.usage)).toBe(false)
})

// Both an empty message and a completed text block lack an executable call.
test.each([
  [],
  [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'No call provided' } } },
    { contentBlockStop: { contentBlockIndex: 0 } }],
].map((events) => [events]))('rejects streamed tool_use without a tool call (%#)', async (events) => {
  await expect(collect([start, ...events, { messageStop: { stopReason: 'tool_use' } }]))
    .rejects.toMatchObject({ name: 'ProviderError', status: 502, retryable: true })
})
