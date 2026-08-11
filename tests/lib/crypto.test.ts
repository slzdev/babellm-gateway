import { beforeEach, describe, expect, test } from 'vitest'
import { decryptJson, encryptJson } from '@/lib/crypto'

describe('crypto', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  })

  test('round-trips an object', () => {
    const value = { apiKey: 'sk-secret', organization: 'org-1' }
    expect(decryptJson(encryptJson(value))).toEqual(value)
  })

  test('produces a different ciphertext each time (random IV)', () => {
    const a = encryptJson({ apiKey: 'x' })
    const b = encryptJson({ apiKey: 'x' })
    expect(a).not.toBe(b)
  })

  test('uses the versioned four-part format', () => {
    expect(encryptJson({ a: 1 }).split('.')).toHaveLength(4)
    expect(encryptJson({ a: 1 }).startsWith('v1.')).toBe(true)
  })

  test('rejects a tampered ciphertext', () => {
    const blob = encryptJson({ apiKey: 'x' })
    const parts = blob.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(() => decryptJson(parts.join('.'))).toThrow()
  })

  test('rejects an unknown format version', () => {
    expect(() => decryptJson('v9.a.b.c')).toThrow(/unsupported/i)
  })

  test('rejects a key of the wrong length', () => {
    process.env.ENCRYPTION_KEY = 'abc'
    expect(() => encryptJson({ a: 1 })).toThrow(/64 hex/i)
  })
})
