import { expect, test } from 'vitest'
import {
  MAX_UUID, MIN_UUID, SHARDS, SHARD_KEYS, boundsFor, shardKey,
} from '@/lib/logs/dynamodb/keys'
import { uuidv7, uuidv7Bound } from '@/lib/uuid'

test('there are sixteen shard keys, one per hex digit', () => {
  expect(SHARDS).toBe(16)
  expect(SHARD_KEYS).toHaveLength(16)
  expect(SHARD_KEYS[0]).toBe('log#0')
  expect(SHARD_KEYS[15]).toBe('log#f')
})

test('every generated id maps to a registered shard key', () => {
  // rand_b is random, so the last hex character is uniform over 0-f.
  // Collect all observed shards across 500 samples and assert full coverage.
  // With 16 uniform buckets, 500 draws leaves negligible chance of an empty
  // bucket. If this ever failed, get() would be looking in a partition that
  // write() never wrote to.
  const observed = new Set(Array.from({ length: 500 }, () => shardKey(uuidv7())))
  expect(observed).toEqual(new Set(SHARD_KEYS))
})

test('shardKey uses the last hex character of the id', () => {
  expect(shardKey('01234567-89ab-7def-8000-00000000000a')).toBe('log#a')
  expect(shardKey('01234567-89ab-7def-8000-000000000003')).toBe('log#3')
})

test('an unfiltered page spans the whole key space', () => {
  expect(boundsFor({ limit: 50 })).toEqual({ lo: MIN_UUID, hi: MAX_UUID, exclude: [] })
})

test('from and to become sort-key bounds', () => {
  const from = new Date('2026-08-01T00:00:00Z')
  const to = new Date('2026-08-14T00:00:00Z')
  const bounds = boundsFor({ limit: 50, from, to })

  expect(bounds.lo).toBe(uuidv7Bound(from))
  expect(bounds.hi).toBe(uuidv7Bound(to))
  // BETWEEN is inclusive and Postgres uses `id < to`, so the upper bound is
  // excluded on the results instead.
  expect(bounds.exclude).toContain(uuidv7Bound(to))
})

test('after narrows the upper bound and is excluded', () => {
  const after = uuidv7()
  const bounds = boundsFor({ limit: 50, after })

  expect(bounds.hi).toBe(after)
  expect(bounds.lo).toBe(MIN_UUID)
  expect(bounds.exclude).toContain(after)
})

test('before narrows the lower bound and is excluded', () => {
  const before = uuidv7()
  const bounds = boundsFor({ limit: 50, before })

  expect(bounds.lo).toBe(before)
  expect(bounds.hi).toBe(MAX_UUID)
  expect(bounds.exclude).toContain(before)
})

test('cursor after wins over time range when narrower on hi', () => {
  // Both to and after constrain hi: assert that the narrower (after) wins.
  const to = new Date('2026-08-14T00:00:00Z')
  const after = uuidv7(new Date('2026-08-10T00:00:00Z'))
  const bounds = boundsFor({ limit: 50, to, after })

  // after is earlier than to, so it is the narrower upper bound.
  expect(bounds.hi).toBe(after)
  expect(bounds.hi < uuidv7Bound(to)).toBe(true)
})

test('cursor before wins over time range when narrower on lo', () => {
  // Both from and before constrain lo: assert that the narrower (before) wins.
  const from = new Date('2026-08-01T00:00:00Z')
  const before = uuidv7(new Date('2026-08-10T00:00:00Z'))
  const bounds = boundsFor({ limit: 50, from, before })

  // before is later than from, so it is the narrower lower bound.
  expect(bounds.lo).toBe(before)
  expect(bounds.lo > uuidv7Bound(from)).toBe(true)
})

test('time range wins when narrower than cursor', () => {
  // When the range bound is narrower than the cursor, it should win.
  const from = new Date('2026-08-10T00:00:00Z')
  const after = uuidv7(new Date('2026-08-01T00:00:00Z'))
  const bounds = boundsFor({ limit: 50, from, after })

  // from is later than after, so from is the narrower lower bound.
  expect(bounds.lo).toBe(uuidv7Bound(from))
})
