/**
 * Hour arithmetic and watermark policy for the usage rollup.
 *
 * Every function is pure and takes its clock explicitly, so a seal boundary,
 * a capped catch-up, and a finished backfill are all tested by passing a
 * value rather than by mocking time. Same shape as src/lib/logs/partitions.ts.
 *
 * All ranges are half-open: `from` inclusive, `to` exclusive.
 */

export const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * How long a bucket stays open after its hour ends.
 *
 * A request's id is minted at its start but its row is inserted at its
 * completion, so a stream starting 10:59 and finishing 11:04 lands after
 * hour 10 was first computed. Two hours of grace is what lets the next tick
 * pick it up.
 *
 * This bounds recompute only — it says nothing about backfill, which sweeps
 * toward oldestLog by construction and will pick up a row landing in an hour
 * it hasn't reached yet regardless of that hour's wall-clock age. An hour is
 * truly unreachable only once both recompute and backfill have passed it,
 * asserted deliberately in tests/lib/stats/rollup.test.ts ("a row arriving in
 * an hour both recompute and backfill have passed is missed") rather than
 * left implied.
 */
export const SEAL_LAG_HOURS = 2

/** Caps one tick's recompute, so an instance returning after a long outage
 * catches up over several ticks instead of in one enormous transaction. */
export const MAX_HOURS_PER_TICK = 168

export const BACKFILL_HOURS_PER_TICK = 24

/** Half-open: `from` inclusive, `to` exclusive. */
export interface HourRange {
  from: Date
  to: Date
}

/** Hours align to the epoch, so flooring the timestamp is the UTC hour —
 * no local-zone arithmetic can creep in. */
export function hourStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

export function addHours(date: Date, count: number): Date {
  return new Date(date.getTime() + count * HOUR_MS)
}

/**
 * The hours to recompute this tick: every hour past the watermark, through
 * the end of the current partial hour.
 *
 * `sealedThrough` names the last hour considered final, so the first hour to
 * recompute is the one after it.
 */
export function unsealedRange(sealedThrough: Date, now: Date): HourRange | null {
  const from = addHours(hourStart(sealedThrough), 1)
  const currentEnd = addHours(hourStart(now), 1)
  if (from >= currentEnd) return null

  const capped = addHours(from, MAX_HOURS_PER_TICK)
  return { from, to: capped < currentEnd ? capped : currentEnd }
}

/**
 * How far the watermark may advance after covering `covered`.
 *
 * Two bounds, and the lower one wins. The lag limit keeps recent hours open
 * for late arrivals; the covered range matters when a capped tick stopped
 * short of it, because sealing past what was actually computed would mark
 * hours final that nothing ever aggregated.
 *
 * Never returns a value below `previous`: a clock that jumped backwards must
 * not re-open sealed hours.
 */
export function nextSealedThrough(previous: Date, covered: HourRange, now: Date): Date {
  const lagLimit = addHours(hourStart(now), -SEAL_LAG_HOURS)
  const coveredLast = addHours(covered.to, -1)
  const candidate = coveredLast < lagLimit ? coveredLast : lagLimit
  return candidate > previous ? candidate : previous
}

/** The watermark a database with no rollup state starts from: exactly one
 * unsealed window behind. Everything older belongs to the backfill. */
export function initialSealedThrough(now: Date): Date {
  return addHours(hourStart(now), -(SEAL_LAG_HOURS + 1))
}

/**
 * The next chunk of history to aggregate, walking backwards from
 * `backfilledTo` toward `oldestLog`. Null once there is nothing older.
 *
 * Backwards because recent history is the most useful: the default 7d view
 * is populated within minutes of first boot while last year fills in over
 * the following hours.
 */
export function backfillChunk(backfilledTo: Date, oldestLog: Date): HourRange | null {
  const to = hourStart(backfilledTo)
  const floor = hourStart(oldestLog)
  if (to <= floor) return null

  const from = addHours(to, -BACKFILL_HOURS_PER_TICK)
  return { from: from > floor ? from : floor, to }
}

export type Grain = 'hour' | 'day' | 'month'

/**
 * Derived from the range rather than chosen by the user: one knob fewer, and
 * a year-long range can never render 8,760 points.
 */
export function grainFor(from: Date, to: Date): Grain {
  const days = (to.getTime() - from.getTime()) / DAY_MS
  if (days <= 2) return 'hour'
  if (days <= 90) return 'day'
  return 'month'
}
