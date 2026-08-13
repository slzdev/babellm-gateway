import { expect, test } from 'vitest'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('generates a well-formed uuid with version 7 and the RFC variant', () => {
  const id = uuidv7()
  expect(id).toMatch(UUID_RE)
  // Version nibble is the first character of the third group.
  expect(id[14]).toBe('7')
  // Variant is 10xx, so the first character of the fourth group is 8, 9, a or b.
  expect('89ab').toContain(id[19])
})

test('ids sort in timestamp order as strings', () => {
  const early = uuidv7(new Date('2026-01-01T00:00:00.000Z'))
  const late = uuidv7(new Date('2026-01-01T00:00:00.001Z'))
  expect(early < late).toBe(true)
})

test('two ids in the same millisecond differ', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  expect(uuidv7(at)).not.toBe(uuidv7(at))
})

test('ids generated within one millisecond still increase', () => {
  // The log viewer orders by id and calls that order chronological. Without a
  // counter, ids sharing a millisecond would sort at random and that claim
  // would be false.
  const at = new Date('2026-03-03T03:03:03.003Z')
  const ids = Array.from({ length: 200 }, () => uuidv7(at))
  expect(ids).toEqual([...ids].sort())
  expect(new Set(ids).size).toBe(200)
})

test('a bound is stable and sorts below every id from that millisecond', () => {
  const at = new Date('2026-06-01T12:00:00.000Z')
  const bound = uuidv7Bound(at)

  expect(bound).toBe(uuidv7Bound(at))
  for (let i = 0; i < 50; i++) {
    expect(bound < uuidv7(at)).toBe(true)
  }
})

test('a bound sorts above every id from the previous millisecond', () => {
  const at = new Date('2026-06-01T12:00:00.000Z')
  const before = new Date(at.getTime() - 1)
  expect(uuidv7(before) < uuidv7Bound(at)).toBe(true)
})
