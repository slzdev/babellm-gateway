import { expect, test } from 'vitest'
import { formatCost, formatCount, formatDelta, formatPointsDelta } from '@/lib/admin/format'

test('cost keeps enough precision to show a small spend', () => {
  // The dashboard aggregates, so it does not need nine places the way a
  // single log row does — but it must not round a real spend to $0.00.
  expect(formatCost('12.345678900')).toBe('$12.3457')
  expect(formatCost('0.000012300')).toBe('$0.0000123')
  expect(formatCost('0')).toBe('$0')
})

test('a value too small for nine decimals never renders a dangling decimal point', () => {
  // Below half a tenth-of-a-nano-dollar, toFixed(9) rounds every decimal to
  // zero, so stripping trailing zeros must not stop at a bare "0." — a
  // malformed string is worse than the imprecision it was trying to avoid.
  expect(formatCost('0.0000000004')).toBe('$0')

  // The boundary itself still keeps full precision: this is what the
  // trailing-zero strip exists for, and the fix above must not regress it.
  expect(formatCost('0.000000001')).toBe('$0.000000001')
})

test('counts get thousands separators', () => {
  expect(formatCount(1234567)).toBe('1,234,567')
})

test('a delta needs a previous period to compare against', () => {
  expect(formatDelta(120, 100)).toBe('+20%')
  expect(formatDelta(80, 100)).toBe('-20%')
  expect(formatDelta(100, 100)).toBe('0%')
  expect(formatDelta(100, null)).toBeNull()
})

test('growth from nothing is not a percentage', () => {
  // 100/0 is Infinity, and "+Infinity%" is not a number a person can read.
  expect(formatDelta(100, 0)).toBe('new')
  expect(formatDelta(0, 0)).toBeNull()
})

test('a rate moves in percentage points', () => {
  expect(formatPointsDelta(0.052, 0.021)).toBe('+3.1 pp')
  expect(formatPointsDelta(0.021, 0.052)).toBe('-3.1 pp')
  expect(formatPointsDelta(0.05, null)).toBeNull()
})

test('a rate that barely moved does not read as an alarm', () => {
  // 0.14% to 0.15% of requests failing is what a percent-of-a-percent turns
  // into "+7%" — and into "+100%" if the rates are rounded to per-mille
  // before the division, which is where this started. Neither is a movement
  // the error-rate tile above it shows.
  expect(formatPointsDelta(0.0015, 0.0014)).toBe('no change')
  expect(formatPointsDelta(0.05, 0.05)).toBe('no change')
})
