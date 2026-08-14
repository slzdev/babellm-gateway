import 'server-only'

/** Bounds what one page of the log viewer can cost. A FilterExpression is
 * applied after Limit, so a narrow filter over a wide range can read a great
 * deal and match almost nothing. */
export const MAX_ROUND_TRIPS = 8
export const MAX_ITEMS_EXAMINED = 10_000

export interface ShardItem {
  sk: string
}

export interface ShardPage<T extends ShardItem> {
  items: T[]
  /** What DynamoDB read, not what it returned — the two differ under a
   * FilterExpression, and the budget cares about the former. */
  scanned: number
  lastEvaluatedKey: Record<string, unknown> | undefined
}

export type ShardFetch<T extends ShardItem> = (
  shard: string,
  startKey: Record<string, unknown> | undefined,
) => Promise<ShardPage<T>>

export interface CollectOptions<T extends ShardItem> {
  fetch: ShardFetch<T>
  shards: readonly string[]
  limit: number
  descending: boolean
  exclude: readonly string[]
}

export interface Collected<T> {
  rows: T[]
  hasMore: boolean
}

/**
 * Merges the shards into one globally ordered page.
 *
 * The invariant that makes this correct: a row may be emitted only when every
 * shard that could still contribute has a buffered head. Each shard's query
 * returns sorted items, so a buffered head is that shard's best remaining
 * candidate — but a shard with an empty buffer and a continuation key could
 * hold something better, and must be fetched before anything is emitted.
 *
 * That invariant is also what lets the caller use a small per-shard Limit.
 * Without it, correctness would require requesting limit + 1 from every shard
 * and reading roughly `shards.length` times the data actually displayed;
 * with it, under-supply is merely another round trip.
 */
export async function collectPage<T extends ShardItem>(
  opts: CollectOptions<T>,
): Promise<Collected<T>> {
  const excluded = new Set(opts.exclude)
  const state = opts.shards.map((shard) => ({
    shard,
    buffer: [] as T[],
    startKey: undefined as Record<string, unknown> | undefined,
    exhausted: false,
  }))

  // One extra row is what distinguishes "this is the last page" from "there
  // is another", without a count query.
  const want = opts.limit + 1
  const matched: T[] = []
  let roundTrips = 0
  let examined = 0
  let budgetSpent = false

  while (matched.length < want) {
    const hungry = state.filter((s) => s.buffer.length === 0 && !s.exhausted)

    if (hungry.length > 0) {
      if (roundTrips >= MAX_ROUND_TRIPS || examined >= MAX_ITEMS_EXAMINED) {
        budgetSpent = true
        break
      }
      roundTrips += 1
      await Promise.all(hungry.map(async (s) => {
        const page = await opts.fetch(s.shard, s.startKey)
        examined += page.scanned
        s.buffer = page.items.filter((item) => !excluded.has(item.sk))
        s.startKey = page.lastEvaluatedKey
        // An empty page with a continuation key is normal under a filter and
        // must not be read as the end of the shard.
        s.exhausted = page.lastEvaluatedKey === undefined
      }))
      continue
    }

    const ready = state.filter((s) => s.buffer.length > 0)
    if (ready.length === 0) break

    let best = ready[0]
    for (const s of ready) {
      const better = opts.descending
        ? s.buffer[0].sk > best.buffer[0].sk
        : s.buffer[0].sk < best.buffer[0].sk
      if (better) best = s
    }
    matched.push(best.buffer.shift() as T)
  }

  return {
    rows: matched.slice(0, opts.limit),
    // A spent budget is reported as "more available" rather than as the end
    // of the data: the page is short, but its cursor still leads somewhere.
    hasMore: matched.length > opts.limit || budgetSpent,
  }
}
