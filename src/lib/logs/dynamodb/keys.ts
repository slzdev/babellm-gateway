import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'
import type { LogFilter } from '../types'

/**
 * Baked into the item keys forever.
 *
 * get() derives an item's partition from the last hex character of its id, so
 * changing this number leaves every existing item unreachable by detail
 * lookup — the list view would still show rows whose detail page 404s. It
 * must never become a setting or an environment variable.
 */
export const SHARDS = 16

export const SHARD_KEYS: readonly string[] = Array.from(
  { length: SHARDS },
  (_, n) => `log#${n.toString(16)}`,
)

/** The lowest and highest values a uuid string can take, so an absent range
 * bound needs no branch in the key condition. */
export const MIN_UUID = '00000000-0000-0000-0000-000000000000'
export const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

/** rand_b is random and untouched by the v7 layout, so the last hex
 * character distributes ids uniformly over the sixteen shards. */
export function shardKey(id: string): string {
  return `log#${id.slice(-1).toLowerCase()}`
}

export interface Bounds {
  lo: string
  hi: string
  /** Ids to drop from the merged results. DynamoDB allows exactly one sort-key
   * condition, so the only range operator available is BETWEEN — inclusive at
   * both ends. Postgres uses `id < to` and excludes the cursor row itself, so
   * the difference is closed here rather than with string-predecessor
   * arithmetic on uuids. */
  exclude: string[]
}

export function boundsFor(filter: LogFilter): Bounds {
  // Mirrors postgres.ts's ternary (`paging.bound` in query()): when `before`
  // is set, `after` is ignored outright rather than intersected with it. A
  // hand-edited URL carrying both cursors must page by `before` alone on
  // both drivers — anything else is two stores answering the same input
  // differently.
  const lowerBounds = [filter.from ? uuidv7Bound(filter.from) : MIN_UUID]
  if (filter.before) lowerBounds.push(filter.before)

  const upperBounds = [filter.to ? uuidv7Bound(filter.to) : MAX_UUID]
  if (filter.after && !filter.before) upperBounds.push(filter.after)

  const exclude: string[] = []
  if (filter.after && !filter.before) exclude.push(filter.after)
  if (filter.before) exclude.push(filter.before)
  if (filter.to) exclude.push(uuidv7Bound(filter.to))

  return {
    // The narrowest bound wins: a cursor from a later page must not be
    // widened back out by the range it sits inside.
    lo: lowerBounds.reduce((a, b) => (a > b ? a : b)),
    hi: upperBounds.reduce((a, b) => (a < b ? a : b)),
    exclude,
  }
}
