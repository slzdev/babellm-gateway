import { beforeEach, expect, test } from 'vitest'
import { signSession, verifySession } from '@/lib/admin/session'

beforeEach(() => {
  process.env.SESSION_SECRET = 'f'.repeat(64)
})

test('a freshly signed session verifies', () => {
  expect(verifySession(signSession(Date.now() + 60_000))).toBe(true)
})

test('an expired session does not verify', () => {
  expect(verifySession(signSession(Date.now() - 1))).toBe(false)
})

test('a tampered expiry does not verify', () => {
  const token = signSession(Date.now() + 60_000)
  const [, signature] = token.split('.')
  expect(verifySession(`${Date.now() + 86_400_000}.${signature}`)).toBe(false)
})

test('a session signed with a different secret does not verify', () => {
  const token = signSession(Date.now() + 60_000)
  process.env.SESSION_SECRET = '0'.repeat(64)
  expect(verifySession(token)).toBe(false)
})

test('undefined and malformed tokens do not verify', () => {
  expect(verifySession(undefined)).toBe(false)
  expect(verifySession('garbage')).toBe(false)
  expect(verifySession('')).toBe(false)
})
