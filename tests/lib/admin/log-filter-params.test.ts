import { expect, test } from 'vitest'
import { nextFilterParams } from '@/lib/admin/log-filter-params'

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
