import { expect, test } from 'vitest'
import { addMonths, monthStart } from '@/lib/logs/months'

test('monthStart truncates to the first instant of the month in UTC', () => {
  expect(monthStart(new Date('2026-08-14T16:13:00Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('monthStart never uses the local zone', () => {
  // 23:30 on the 31st in UTC+2 is still the 31st in UTC. A local-zone
  // implementation would put the same instant in different months on
  // instances deployed to different regions.
  expect(monthStart(new Date('2026-08-31T21:30:00Z')).toISOString())
    .toBe('2026-08-01T00:00:00.000Z')
})

test('addMonths works from the truncated month, not the given day', () => {
  // Date.UTC(2026, 1, 31) is 3 March. Truncating first is what stops a
  // caller passing the 31st from landing two months out.
  expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString())
    .toBe('2026-02-01T00:00:00.000Z')
})

test('addMonths crosses year boundaries in both directions', () => {
  expect(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString())
    .toBe('2027-02-01T00:00:00.000Z')
  expect(addMonths(new Date('2026-02-15T00:00:00Z'), -3).toISOString())
    .toBe('2025-11-01T00:00:00.000Z')
})
