import { expect, test } from 'vitest'
import { addTagParam, nextFilterParams, removeTagParam } from '@/lib/admin/log-filter-params'

test('selecting "All time" keeps range=all in the URL rather than deleting it', () => {
  const next = nextFilterParams(new URLSearchParams(), 'range', 'all')
  expect(next.get('range')).toBe('all')
})

test('selecting the 24h default range omits the param, since that is the default', () => {
  const next = nextFilterParams(new URLSearchParams('range=1h'), 'range', '24h')
  expect(next.has('range')).toBe(false)
})

test('selecting "Any key" removes the key param', () => {
  const next = nextFilterParams(new URLSearchParams('key=k-1'), 'key', 'all')
  expect(next.has('key')).toBe(false)
})

test('selecting "Any model" removes the model param', () => {
  const next = nextFilterParams(new URLSearchParams('model=house-model'), 'model', 'all')
  expect(next.has('model')).toBe(false)
})

test('selecting "Any status" removes the status param', () => {
  const next = nextFilterParams(new URLSearchParams('status=success'), 'status', 'all')
  expect(next.has('status')).toBe(false)
})

test('choosing the default page size omits the param', () => {
  const next = nextFilterParams(new URLSearchParams('size=5'), 'size', '50')
  expect(next.has('size')).toBe(false)
})

test('choosing a non-default page size writes it', () => {
  const next = nextFilterParams(new URLSearchParams(), 'size', '5')
  expect(next.get('size')).toBe('5')
})

test('changing the page size clears the cursors, since they describe a page of the old size', () => {
  const next = nextFilterParams(new URLSearchParams('after=a&range=1h'), 'size', '100')
  expect(next.has('after')).toBe(false)
  expect(next.get('range')).toBe('1h')
})

test('every change clears both cursors', () => {
  const next = nextFilterParams(new URLSearchParams('after=a&before=b&range=1h'), 'range', '7d')
  expect(next.has('after')).toBe(false)
  expect(next.has('before')).toBe(false)
  expect(next.get('range')).toBe('7d')
})

test('unrelated filters survive the change', () => {
  const next = nextFilterParams(new URLSearchParams('key=k-1&model=m'), 'range', 'all')
  expect(next.get('key')).toBe('k-1')
  expect(next.get('model')).toBe('m')
  expect(next.get('range')).toBe('all')
})

test('addTagParam appends a token for a new key, so tags accumulate', () => {
  const next = addTagParam(new URLSearchParams('tag=env%3Dprod'), 'team=a')
  expect(next.getAll('tag')).toEqual(['env=prod', 'team=a'])
})

test('addTagParam replaces the existing token for the same key rather than appending', () => {
  const next = addTagParam(new URLSearchParams('tag=env%3Dprod'), 'env=staging')
  expect(next.getAll('tag')).toEqual(['env=staging'])
})

test('addTagParam clears the keyset cursors', () => {
  const next = addTagParam(new URLSearchParams('after=abc&before=def'), 'env=prod')
  expect(next.get('after')).toBeNull()
  expect(next.get('before')).toBeNull()
})

test('addTagParam preserves the other filters', () => {
  const next = addTagParam(new URLSearchParams('range=7d&model=house'), 'env=prod')
  expect(next.get('range')).toBe('7d')
  expect(next.get('model')).toBe('house')
})

test('removeTagParam drops only the named tag', () => {
  const next = removeTagParam(
    new URLSearchParams('tag=env%3Dprod&tag=team%3Da'),
    'env=prod',
  )
  expect(next.getAll('tag')).toEqual(['team=a'])
})

test('removeTagParam clears the keyset cursors', () => {
  const next = removeTagParam(new URLSearchParams('tag=env%3Dprod&after=abc'), 'env=prod')
  expect(next.get('after')).toBeNull()
})

test('removing the last tag leaves no tag param at all', () => {
  const next = removeTagParam(new URLSearchParams('tag=env%3Dprod'), 'env=prod')
  expect(next.getAll('tag')).toEqual([])
})
