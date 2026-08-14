import { expect, test } from 'vitest'
import {
  allKeysFor, bucketOf, estimate, monthOf, monthlySpendKey, secondsToMonthEnd,
  secondsToWindowEnd, totalSpendKey, windowKey,
} from '@/lib/usage/keys'

const AUG_14 = Date.UTC(2026, 7, 14, 10, 30, 15, 0)

test('a bucket is the minute a request lands in', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  expect(bucketOf(AUG_14)).toBe(minuteStart / 60_000)
  expect(bucketOf(minuteStart + 59_999)).toBe(bucketOf(AUG_14))
  expect(bucketOf(minuteStart + 60_000)).toBe(bucketOf(AUG_14) + 1)
})

test('the month is UTC, zero padded', () => {
  expect(monthOf(AUG_14)).toBe('2026-08')
  expect(monthOf(Date.UTC(2026, 0, 1))).toBe('2026-01')
  // 23:30 on the 31st in UTC+2 is still January to this gateway.
  expect(monthOf(Date.UTC(2026, 0, 31, 23, 30))).toBe('2026-01')
})

test('counter names are namespaced and stable', () => {
  expect(windowKey('rpm', 'abc', 100)).toBe('babellm:usage:rpm:abc:100')
  expect(windowKey('tpm', 'abc', 100)).toBe('babellm:usage:tpm:abc:100')
  expect(monthlySpendKey('abc', AUG_14)).toBe('babellm:usage:spend:abc:2026-08')
  expect(totalSpendKey('abc')).toBe('babellm:usage:spend:abc:total')
})

test('allKeysFor names everything a deleted key could still own', () => {
  const bucket = bucketOf(AUG_14)
  expect(allKeysFor('abc', AUG_14).sort()).toEqual([
    windowKey('rpm', 'abc', bucket - 1),
    windowKey('rpm', 'abc', bucket),
    windowKey('tpm', 'abc', bucket - 1),
    windowKey('tpm', 'abc', bucket),
    monthlySpendKey('abc', AUG_14),
    totalSpendKey('abc'),
  ].sort())
})

test('the sliding window weights the previous bucket by what is left of it', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  // Exactly on the boundary: the previous minute counts in full.
  expect(estimate(100, 0, minuteStart)).toBeCloseTo(100, 6)
  // A quarter of the way in: three quarters of it remains.
  expect(estimate(100, 0, minuteStart + 15_000)).toBeCloseTo(75, 6)
  // Nearly through: almost none of it.
  expect(estimate(100, 0, minuteStart + 59_999)).toBeCloseTo(0.0017, 3)
  // The current bucket always counts in full.
  expect(estimate(100, 8, minuteStart + 30_000)).toBeCloseTo(58, 6)
})

test('reset seconds count to the end of the current window', () => {
  const minuteStart = Math.floor(AUG_14 / 60_000) * 60_000
  expect(secondsToWindowEnd(minuteStart)).toBe(60)
  expect(secondsToWindowEnd(minuteStart + 30_000)).toBe(30)
  // Never zero: "retry immediately" would be a lie inside the window.
  expect(secondsToWindowEnd(minuteStart + 59_999)).toBe(1)
})

test('reset seconds for a budget count to the first of the next month, UTC', () => {
  const oneDay = 24 * 60 * 60
  expect(secondsToMonthEnd(Date.UTC(2026, 7, 31, 0, 0, 0))).toBe(oneDay)
  expect(secondsToMonthEnd(Date.UTC(2026, 11, 31, 12, 0, 0))).toBe(oneDay / 2)
})
