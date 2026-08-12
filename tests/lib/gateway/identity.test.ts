import { expect, test } from 'vitest'
import { newCompletionId, rewriteChunk, rewriteCompletion } from '@/lib/gateway/identity'

const opts = { id: 'chatcmpl-gateway', model: 'house-model' }

test('generates a unique OpenAI-shaped completion id', () => {
  expect(newCompletionId()).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(newCompletionId()).not.toBe(newCompletionId())
})

test('rewrites the id and model on a completion, preserving everything else', () => {
  const upstream = {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 7, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    system_fingerprint: 'fp_1',
  }

  const result = rewriteCompletion(upstream as never, opts)
  expect(result.id).toBe('chatcmpl-gateway')
  expect(result.model).toBe('house-model')
  expect(result.created).toBe(7)
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(3)
  expect((result as unknown as Record<string, unknown>).system_fingerprint).toBe('fp_1')
})

test('rewrites the id and model on a chunk without touching the delta', () => {
  const chunk = {
    id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 7, model: 'gpt-4o-mini',
    choices: [{ index: 0, delta: { content: 'he' }, finish_reason: null }],
  }

  const result = rewriteChunk(chunk as never, opts)
  expect(result.id).toBe('chatcmpl-gateway')
  expect(result.model).toBe('house-model')
  expect(result.choices[0].delta.content).toBe('he')
})

test('rewriting does not mutate the upstream object', () => {
  const chunk = {
    id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 7, model: 'gpt-4o-mini',
    choices: [],
  }
  rewriteChunk(chunk as never, opts)
  expect(chunk.id).toBe('chatcmpl-upstream')
})
