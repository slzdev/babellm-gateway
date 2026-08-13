import { expect, test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { fromGenerateContentStream } from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const req: ChatCompletionRequest = {
  model: 'virtual',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
}

// GenerateContentResponse is a class with derived accessors (text, data,
// functionCalls, ...) that a plain fixture object never has, so tsc rejects
// a direct cast as insufficiently overlapping. The fixtures here only ever
// exercise the plain data fields fromGenerateContentStream reads.
async function* source(...responses: Record<string, unknown>[]) {
  for (const response of responses) yield response as unknown as GenerateContentResponse
}

async function collect(
  stream: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('text deltas become content deltas, with the role on the first one', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'he' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'llo' }] } }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'he' })
  expect(chunks[1].choices[0].delta).toEqual({ content: 'llo' })
})

test('the model version from the stream replaces the fallback', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].model).toBe('gemini-2.5-flash-001')
})

test('thought parts stream as reasoning_content', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }),
    req,
    'gemini-2.5-pro',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'hmm' })
})

test('a function call arrives as one complete tool_calls fragment', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] } }],
    }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta.tool_calls).toEqual([{
    index: 0,
    id: 'call_0_0',
    type: 'function',
    function: { name: 'f', arguments: '{"a":1}' },
  }])
})

test('a finish reason is emitted on its own chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks.at(-1)?.choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' })
})

test('a stream that produced tool calls finishes as tool_calls', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls')
})

test('usage rides a final choices-empty chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      },
    ),
    req,
    'gemini-2.5-flash',
  ))

  const last = chunks.at(-1)
  expect(last?.choices).toEqual([])
  expect(last?.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
})

test('include_usage false suppresses the usage chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
    { ...req, stream_options: { include_usage: false } },
    'gemini-2.5-flash',
  ))

  expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true)
})

test('a blocked prompt ends the stream with a content_filter finish', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks).toHaveLength(1)
  expect(chunks[0].choices[0].finish_reason).toBe('content_filter')
})

test('candidates keep their own choice index when n is above 1', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] } },
        { index: 1, content: { parts: [{ text: 'two' }] } },
      ],
    }),
    { ...req, n: 2 },
    'gemini-2.5-flash',
  ))

  expect(chunks.map((c) => [c.choices[0].index, c.choices[0].delta.content]))
    .toEqual([[0, 'one'], [1, 'two']])
})

test('each choice gets its own role chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] } },
        { index: 1, content: { parts: [{ text: 'two' }] } },
      ],
    }),
    { ...req, n: 2 },
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'one' })
  expect(chunks[1].choices[0].delta).toEqual({ role: 'assistant', content: 'two' })
})
