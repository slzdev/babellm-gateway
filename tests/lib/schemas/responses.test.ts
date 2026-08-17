import { expect, test } from 'vitest'
import { responsesRequestSchema } from '@/lib/schemas/responses'

test('accepts a bare string input', () => {
  const parsed = responsesRequestSchema.parse({ model: 'm', input: 'hello' })
  expect(parsed.input).toBe('hello')
})

test('accepts structured input items', () => {
  const parsed = responsesRequestSchema.parse({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  })
  expect(Array.isArray(parsed.input)).toBe(true)
})

test('keeps unknown keys so they reach the provider', () => {
  // Passthrough is the whole point of the Responses-native path: a field this
  // gateway has never heard of must not be stripped on its way upstream.
  const parsed = responsesRequestSchema.parse({ model: 'm', input: 'hi', some_new_field: 1 })
  expect((parsed as Record<string, unknown>).some_new_field).toBe(1)
})

test('rejects background because the retrieval endpoints do not exist', () => {
  // Rejected for every target, not just chat-only ones: a queued response would
  // be unretrievable, since GET /v1/responses/{id} is out of scope.
  const result = responsesRequestSchema.safeParse({ model: 'm', input: 'hi', background: true })
  expect(result.success).toBe(false)
})

test('allows background: false', () => {
  expect(responsesRequestSchema.safeParse({ model: 'm', input: 'hi', background: false }).success).toBe(true)
})

test('requires a model', () => {
  expect(responsesRequestSchema.safeParse({ input: 'hi' }).success).toBe(false)
})
