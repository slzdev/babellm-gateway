import { expect, test } from 'vitest'
import { TAGS_HEADER, parseTags } from '@/lib/tags'

/** Unwraps a parse expected to succeed, so a failure shows its message
 * instead of a bare `undefined` mismatch. */
function ok(raw: string | null | undefined) {
  const result = parseTags(raw)
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.message}`)
  return result.tags
}

function err(raw: string) {
  const result = parseTags(raw)
  if (result.ok) throw new Error('expected a failed parse')
  return result.message
}

test('the header name is the one the gateway documents', () => {
  expect(TAGS_HEADER).toBe('x-babellm-tags')
})

test('parses comma-separated key=value pairs', () => {
  expect(ok('env=prod,feature=checkout')).toEqual({ env: 'prod', feature: 'checkout' })
})

test('trims whitespace around both sides of a pair', () => {
  expect(ok('  env = prod ,  team =a ')).toEqual({ env: 'prod', team: 'a' })
})

test('lowercases keys but preserves value case', () => {
  expect(ok('ENV=Prod')).toEqual({ env: 'Prod' })
})

test('splits on the first = only, so a value may contain one', () => {
  expect(ok('note=a=b')).toEqual({ note: 'a=b' })
})

// null is "no tags", not an error, and must be distinguishable from {} —
// the write path stores null and never {}, so the two cannot be conflated.
test.each([
  ['absent', null],
  ['undefined', undefined],
  ['empty', ''],
  ['whitespace only', '   '],
])('a %s header parses as no tags at all', (_label, raw) => {
  expect(ok(raw)).toBeNull()
})

test('accepts every character the key charset allows', () => {
  expect(ok('a_b.c-d9=x')).toEqual({ 'a_b.c-d9': 'x' })
})

test('accepts exactly 16 pairs', () => {
  const raw = Array.from({ length: 16 }, (_, i) => `k${i}=v`).join(',')
  expect(Object.keys(ok(raw) ?? {})).toHaveLength(16)
})

test('rejects a 17th pair and says how many it got', () => {
  const raw = Array.from({ length: 17 }, (_, i) => `k${i}=v`).join(',')
  expect(err(raw)).toBe('x-babellm-tags: at most 16 tags, got 17')
})

test('rejects a header over 2048 bytes before counting pairs', () => {
  // One pair, so the pair count is legal — only the size rule can reject it.
  const raw = `k=${'v'.repeat(3000)}`
  expect(err(raw)).toBe('x-babellm-tags: header is at most 2048 bytes, got 3002')
})

test('measures the size limit in utf-8 bytes, not characters', () => {
  // 'é' is two bytes: 1025 of them is 2050 bytes but only 1027 characters.
  const raw = `k=${'é'.repeat(1025)}`
  expect(err(raw)).toContain('at most 2048 bytes')
})

test('rejects a token with no =', () => {
  expect(err('env=prod,justalabel')).toBe(
    'x-babellm-tags: "justalabel" is not a key=value pair',
  )
})

test('rejects a key outside the allowed charset', () => {
  expect(err('team name=a')).toBe(
    'x-babellm-tags: key "team name" is not a valid tag key',
  )
})

test('rejects an empty key', () => {
  expect(err('=prod')).toBe('x-babellm-tags: key "" is not a valid tag key')
})

test('rejects a key over 64 characters', () => {
  const key = 'k'.repeat(65)
  expect(err(`${key}=v`)).toBe(`x-babellm-tags: key "${key}" is not a valid tag key`)
})

test('rejects an empty value', () => {
  expect(err('env=')).toBe('x-babellm-tags: tag "env" has an empty value')
})

test('rejects a value over 256 characters', () => {
  expect(err(`env=${'v'.repeat(257)}`)).toBe(
    'x-babellm-tags: value for "env" is at most 256 characters, got 257',
  )
})

test('rejects a control character in a value', () => {
  expect(err('env=pr\u0007od')).toBe(
    'x-babellm-tags: value for "env" contains a control character',
  )
})

test('rejects DEL as a control character too', () => {
  expect(err('env=pr\u007fod')).toBe(
    'x-babellm-tags: value for "env" contains a control character',
  )
})

// Trimming runs before the control check, so a value that is only whitespace
// is an empty value rather than a control-character rejection.
test('a tab-only value is an empty value, not a control character', () => {
  expect(err('env=\t')).toBe('x-babellm-tags: tag "env" has an empty value')
})

test('rejects a duplicate key, after lowercasing', () => {
  expect(err('env=prod,ENV=staging')).toBe('x-babellm-tags: duplicate key "env"')
})
