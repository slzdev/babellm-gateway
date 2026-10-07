import { expect, test } from 'vitest'
import { decisionsRequestSchema } from '@/lib/schemas/decisions'

const predicate = { type: 'predicate', instructions: 'Is it damaged?' }
const body = { model: 'house-model', input: 'Broken screen', questions: [predicate] }
const image = { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }

test('preserves typed choices, ordered levels and provider extensions', () => {
  const request = {
    ...body,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Evidence', extension: 1 }, image] }],
    questions: [predicate,
      { type: 'choice', instructions: '', choices: [{ value: true }, { value: 'true', description: '' }] },
      { type: 'score', instructions: 'Severity', levels: [{ label: 'low' }, { label: 'high' }] },
    ],
    safety_identifier: null, provider_option: { enabled: true }, stream: false,
  }
  expect(decisionsRequestSchema.parse(request)).toEqual(request)
})

test.each([
  { input: [{ role: 'assistant', content: 'text' }] },
  { input: [{ role: 'user', type: 'function_call', content: 'text' }] },
  { input: [{ role: 'user', content: [{ type: 'input_audio', data: 'x' }] }] },
  { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] },
  { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] },
  { input: [{ role: 'user', content: [{ ...image, detail: 'invalid' }] }] },
  { input: [{ role: 'user', content: [{ ...image, image_url: 'data:image/png;base64,a' }] }] },
  { input: [{ role: 'user', content: [{ ...image, file_id: 'file_1' }] }] },
  { input: [{ role: 'user', content: [{ ...image, image_url: 'data:image/png,not-base64' }] }] },
  { questions: [{ type: 'predicate' }] },
  { questions: [{ type: 'choice', instructions: 'Choose', choices: [{ value: 1 }] }] },
  { questions: [{ type: 'score', instructions: 'Rate', levels: [{ label: true }] }] },
  { questions: [{ type: 'unknown', instructions: 'x' }] },
  { safety_identifier: 'x'.repeat(129) },
  { stream: true },
])('rejects unsupported or malformed forms: %j', (patch) => {
  expect(decisionsRequestSchema.safeParse({ ...body, ...patch }).success).toBe(false)
})

test('counts the 128-image limit across messages', () => {
  const input = [
    { role: 'user', content: Array.from({ length: 64 }, () => image) },
    { role: 'user', content: Array.from({ length: 64 }, () => ({ ...image, detail: null })) },
  ]
  expect(decisionsRequestSchema.safeParse({ ...body, input }).success).toBe(true)
  input[0].content.push(image)
  expect(decisionsRequestSchema.safeParse({ ...body, input }).success).toBe(false)
})

test('allows empty documented arrays and enforces documented string bounds', () => {
  expect(decisionsRequestSchema.safeParse({ ...body, questions: [] }).success).toBe(true)
  expect(decisionsRequestSchema.safeParse({ ...body, questions: [{ type: 'choice', instructions: '', choices: [] }] }).success).toBe(true)
  expect(decisionsRequestSchema.safeParse({ ...body, questions: [{ ...predicate, name: 'x'.repeat(1048577) }] }).success).toBe(false)
  expect(decisionsRequestSchema.safeParse({ ...body, safety_identifier: 'x'.repeat(128) }).success).toBe(true)
})
