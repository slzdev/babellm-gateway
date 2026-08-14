import { expect, test } from 'vitest'
import { capPayload } from '@/lib/logs/payload'

test('a small payload passes through untouched', () => {
  const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }
  expect(capPayload(body, 1024)).toEqual({ value: body, truncated: false })
})

test('an oversized payload becomes a valid-JSON envelope', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  const capped = capPayload(body, 512) as { value: Record<string, unknown>; truncated: boolean }

  expect(capped.truncated).toBe(true)
  expect(capped.value.truncated).toBe(true)
  expect(capped.value.bytes).toBeGreaterThan(5000)
  expect(typeof capped.value.preview).toBe('string')
  // The whole point of an envelope over a clipped string: it survives a
  // round trip through a jsonb column.
  expect(() => JSON.parse(JSON.stringify(capped.value))).not.toThrow()
})

test('the preview stays within the cap', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
  const capped = capPayload(body, 512) as { value: { preview: string }; truncated: boolean }
  expect(Buffer.byteLength(capped.value.preview ?? '', 'utf8')).toBeLessThanOrEqual(512)
})

test('a value that cannot be serialized becomes an envelope rather than throwing', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const capped = capPayload(cyclic, 1024) as { value: Record<string, unknown>; truncated: boolean }

  expect(capped.truncated).toBe(true)
  expect(capped.value.error).toBe('unserializable')
})

test('null and undefined pass through as null', () => {
  expect(capPayload(undefined, 1024)).toEqual({ value: null, truncated: false })
  expect(capPayload(null, 1024)).toEqual({ value: null, truncated: false })
})

test('multi-byte characters are not split at the boundary', () => {
  const body = { messages: [{ role: 'user', content: '😀'.repeat(500) }] }
  const capped = capPayload(body, 50) as { value: { preview: string }; truncated: boolean }
  expect(Buffer.byteLength(capped.value.preview ?? '', 'utf8')).toBeLessThanOrEqual(50)
})

test('preview contains no replacement character', () => {
  const body = { messages: [{ role: 'user', content: '😀'.repeat(500) }] }
  const capped = capPayload(body, 50) as { value: { preview: string }; truncated: boolean }
  expect(capped.value.preview).not.toContain('�')
})

test('byte cap holds across all offsets within a multi-byte character', () => {
  const emoji = '😀' // 4-byte UTF-8 character
  const body = { messages: [{ role: 'user', content: emoji.repeat(100) }] }

  // Test caps from 40 to 47, covering various offsets within a 4-byte character
  for (let cap = 40; cap <= 47; cap++) {
    const capped = capPayload(body, cap) as { value: { preview: string }; truncated: boolean }
    const byteLength = Buffer.byteLength(capped.value.preview ?? '', 'utf8')
    expect(byteLength).toBeLessThanOrEqual(cap)
  }
})
