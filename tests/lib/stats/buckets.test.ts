import { expect, test } from 'vitest'
import {
  BACKFILL_HOURS_PER_TICK, MAX_HOURS_PER_TICK, SEAL_LAG_HOURS,
  addHours, backfillChunk, grainFor, hourStart, initialSealedThrough,
  nextSealedThrough, unsealedRange,
} from '@/lib/stats/buckets'

const utc = (iso: string) => new Date(iso)

test('hourStart truncates to the hour in UTC', () => {
  expect(hourStart(utc('2026-08-14T13:47:03.123Z')).toISOString())
    .toBe('2026-08-14T13:00:00.000Z')
})

test('hourStart uses UTC, not the local zone', () => {
  // 23:30 UTC is already tomorrow east of Greenwich. Reading the local hour
  // would file the same row in different buckets on different servers.
  expect(hourStart(utc('2026-08-14T23:30:00Z')).toISOString())
    .toBe('2026-08-14T23:00:00.000Z')
})

test('addHours crosses a day boundary', () => {
  expect(addHours(utc('2026-08-14T23:00:00Z'), 2).toISOString())
    .toBe('2026-08-15T01:00:00.000Z')
  expect(addHours(utc('2026-08-15T01:00:00Z'), -2).toISOString())
    .toBe('2026-08-14T23:00:00.000Z')
})

test('unsealedRange covers the first unsealed hour through the current one', () => {
  // Sealed through 10:00 means hour 10 is final; recompute starts at 11:00
  // and runs through the end of the current (partial) hour 13.
  const range = unsealedRange(utc('2026-08-14T10:00:00Z'), utc('2026-08-14T13:20:00Z'))

  expect(range?.from.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(range?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
})

test('unsealedRange returns null when the sealed point is already current', () => {
  // Cannot happen with a lag of 2, but the caller must not have to know that.
  expect(unsealedRange(utc('2026-08-14T13:00:00Z'), utc('2026-08-14T13:20:00Z')))
    .toBeNull()
})

test('unsealedRange caps a long catch-up at MAX_HOURS_PER_TICK', () => {
  // An instance returning after a month must not do it in one transaction.
  const range = unsealedRange(utc('2026-07-01T00:00:00Z'), utc('2026-08-14T13:20:00Z'))

  expect(range?.from.toISOString()).toBe('2026-07-01T01:00:00.000Z')
  expect(range?.to.toISOString())
    .toBe(addHours(utc('2026-07-01T01:00:00Z'), MAX_HOURS_PER_TICK).toISOString())
})

test('nextSealedThrough leaves the last SEAL_LAG_HOURS open', () => {
  // Hour 13 is current, so 12 and 11 stay open for requests that started in
  // them and have not finished yet. 11:00 is the newest sealable hour.
  const covered = { from: utc('2026-08-14T11:00:00Z'), to: utc('2026-08-14T14:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-08-14T10:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(sealed.toISOString())
    .toBe(addHours(hourStart(utc('2026-08-14T13:20:00Z')), -SEAL_LAG_HOURS).toISOString())
})

test('nextSealedThrough seals only what a capped tick actually covered', () => {
  // The catch-up stopped short of the lag limit. Sealing to the lag limit
  // would mark hours final that this tick never computed — they would never
  // be computed at all.
  const covered = { from: utc('2026-07-01T01:00:00Z'), to: utc('2026-07-08T01:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-07-01T00:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-07-08T00:00:00.000Z')
})

test('nextSealedThrough never moves backwards', () => {
  // A clock that jumped back, or a covered range behind the watermark, must
  // not re-open hours that are already sealed.
  const covered = { from: utc('2026-08-14T11:00:00Z'), to: utc('2026-08-14T12:00:00Z') }
  const sealed = nextSealedThrough(utc('2026-08-14T20:00:00Z'), covered, utc('2026-08-14T13:20:00Z'))

  expect(sealed.toISOString()).toBe('2026-08-14T20:00:00.000Z')
})

test('initialSealedThrough starts one hour below the first unsealed hour', () => {
  // A first tick must recompute exactly the unsealed window and nothing
  // else; everything older is the backfill's job.
  const now = utc('2026-08-14T13:20:00Z')
  const range = unsealedRange(initialSealedThrough(now), now)

  expect(range?.from.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(range?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
})

test('backfillChunk walks backwards a day at a time', () => {
  const chunk = backfillChunk(utc('2026-08-14T11:00:00Z'), utc('2026-05-01T09:00:00Z'))

  expect(chunk?.to.toISOString()).toBe('2026-08-14T11:00:00.000Z')
  expect(chunk?.from.toISOString())
    .toBe(addHours(utc('2026-08-14T11:00:00Z'), -BACKFILL_HOURS_PER_TICK).toISOString())
})

test('backfillChunk stops at the oldest log rather than overshooting', () => {
  const chunk = backfillChunk(utc('2026-05-02T00:00:00Z'), utc('2026-05-01T09:40:00Z'))

  expect(chunk?.from.toISOString()).toBe('2026-05-01T09:00:00.000Z')
  expect(chunk?.to.toISOString()).toBe('2026-05-02T00:00:00.000Z')
})

test('backfillChunk returns null once the oldest log is covered', () => {
  expect(backfillChunk(utc('2026-05-01T09:00:00Z'), utc('2026-05-01T09:40:00Z'))).toBeNull()
})

test('grainFor picks a resolution the chart can actually render', () => {
  const from = utc('2026-01-01T00:00:00Z')

  expect(grainFor(from, addHours(from, 24))).toBe('hour')
  expect(grainFor(from, addHours(from, 48))).toBe('hour')
  // A year of hourly points is 8,760 of them. Nobody reads that chart.
  expect(grainFor(from, addHours(from, 49))).toBe('day')
  expect(grainFor(from, addHours(from, 90 * 24))).toBe('day')
  expect(grainFor(from, addHours(from, 91 * 24))).toBe('month')
})
