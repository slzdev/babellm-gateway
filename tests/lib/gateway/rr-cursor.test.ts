import { beforeEach, expect, test } from 'vitest'
import { nextCursor, resetCursors } from '@/lib/gateway/rr-cursor'

beforeEach(() => {
  resetCursors()
})

test('the first call for a model returns zero', () => {
  expect(nextCursor('vm-1')).toBe(0)
})

test('successive calls advance', () => {
  expect([nextCursor('vm-1'), nextCursor('vm-1'), nextCursor('vm-1')]).toEqual([0, 1, 2])
})

test('each virtual model keeps its own cursor', () => {
  nextCursor('vm-1')
  nextCursor('vm-1')
  expect(nextCursor('vm-2')).toBe(0)
  expect(nextCursor('vm-1')).toBe(2)
})

test('the cursor wraps rather than growing without bound', () => {
  // A long-lived process would otherwise walk a counter toward
  // MAX_SAFE_INTEGER, where increments stop being exact.
  for (let i = 0; i < 3; i += 1) nextCursor('vm-wrap')
  expect(nextCursor('vm-wrap')).toBeLessThan(0x7fffffff)
})
