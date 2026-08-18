import { expect, test } from 'vitest'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, parseTimeoutMs } from '@/lib/timeouts'

test('the default attempt timeout is 30 seconds', () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
})

test('a blank value clears back to the default', () => {
  expect(parseTimeoutMs('')).toBeNull()
  expect(parseTimeoutMs('   ')).toBeNull()
})

test('a valid integer is returned as a number', () => {
  expect(parseTimeoutMs('600000')).toBe(600_000)
  expect(parseTimeoutMs(' 600000 ')).toBe(600_000)
})

test('the bounds are inclusive at both ends', () => {
  expect(parseTimeoutMs('1')).toBe(1)
  expect(parseTimeoutMs(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS)
})

test('a value outside the bounds is an error, not a silently ignored field', () => {
  expect(() => parseTimeoutMs('0')).toThrow(/between 1 and 3600000/)
  expect(() => parseTimeoutMs('-5')).toThrow(/between 1 and 3600000/)
  expect(() => parseTimeoutMs(String(MAX_TIMEOUT_MS + 1))).toThrow(/between 1 and 3600000/)
})

test('a non-integer is an error', () => {
  expect(() => parseTimeoutMs('abc')).toThrow(/whole number of milliseconds/)
  expect(() => parseTimeoutMs('1.5')).toThrow(/whole number of milliseconds/)
  expect(() => parseTimeoutMs('1e5')).toThrow(/whole number of milliseconds/)
})
