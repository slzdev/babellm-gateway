import { beforeEach, expect, test } from 'vitest'
import { nextCursor, resetCursors, seedCursor, WRAP } from '@/lib/gateway/rr-cursor'

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

test('the cursor wraps at its bound rather than growing without limit', () => {
  seedCursor('vm-wrap', WRAP - 1)

  // Post-increment: this call returns the seeded value and stores the wrap.
  expect(nextCursor('vm-wrap')).toBe(WRAP - 1)
  expect(nextCursor('vm-wrap')).toBe(0)
})
