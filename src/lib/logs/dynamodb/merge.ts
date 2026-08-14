import 'server-only'

/**
 * Bounds what one page of the log viewer can cost. A FilterExpression is
 * applied after Limit, so a narrow filter over a wide range can read a great
 * deal and match almost nothing.
 *
 * One round trip fetches every still-hungry shard in parallel — up to
 * shards.length queries — and each carries only a small per-shard Limit (the
 * driver computes roughly 4-11 items per shard per round). MAX_ITEMS_EXAMINED
 * is meant to be the binding cost constraint; MAX_ROUND_TRIPS is a backstop
 * against pathologically many round trips, not the primary budget, so it is
 * set high enough that the item cap trips first in the ordinary case.
 */
export const MAX_ROUND_TRIPS = 40
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
  /** Sort direction for the merge. The caller's fetch must return each
   * shard's items in this same direction (e.g. via ScanIndexForward) — the
   * merge has no way to verify that and would silently produce a
   * mis-ordered page if it didn't. */
  descending: boolean
  exclude: readonly string[]
}

export interface Collected<T> {
  rows: T[]
  hasMore: boolean
  /**
   * Where scanning stopped, as a plain sk — meaningful when `rows` is empty
   * and `hasMore` is true: the budget was spent before anything could be
   * emitted, and without this the caller has no cursor to resume from at
   * all (see query() in index.ts). Null when there is nothing to resume
   * from, or when resuming safely can't be established (see below).
   *
   * A shard's stopping point is not simply its own lastEvaluatedKey. A shard
   * can read real matches into its buffer and then go untouched for many
   * rounds — the loop above only re-fetches shards whose buffer is empty —
   * while other shards alone burn through the rest of the budget. If that
   * happens, this call ends with zero rows emitted (the frontier invariant
   * forbids emitting from one shard's buffer while another is still
   * unfetched) even though a real match is sitting in a buffer that is
   * about to be discarded when this call returns. That buffered row's sk is
   * *larger* (descending) than the stalled shard's own lastEvaluatedKey, so
   * using the latter as resumeFrom would place the row outside every future
   * query's range — a silent, permanent skip.
   *
   * There is no cheap way to recover a safe cutoff in that situation (it
   * would require remembering where each buffered page started, not just
   * where it ended), so resumeFrom is only ever computed when every shard's
   * buffer is empty. That is also exactly the case that matters in
   * practice: a filter that has matched nothing anywhere yet, which is why
   * `rows` came back empty in the first place. When it holds, no shard has
   * found anything that isn't already reflected in its own
   * lastEvaluatedKey, so the extremum below is safe. When it doesn't — some
   * shard found something but got stalled — resumeFrom degrades to null,
   * matching today's behavior, rather than risk a skip.
   */
  resumeFrom: string | null
}

function stopKeyOf(key: Record<string, unknown> | undefined): string | undefined {
  const sk = key?.sk
  return typeof sk === 'string' ? sk : undefined
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

  // Safe only when nothing is stuck in a buffer — see the doc comment on
  // Collected.resumeFrom for why.
  let resumeFrom: string | null = null
  if (state.every((s) => s.buffer.length === 0)) {
    for (const s of state) {
      if (s.exhausted) continue
      const sk = stopKeyOf(s.startKey)
      if (sk === undefined) continue
      if (resumeFrom === null || (opts.descending ? sk > resumeFrom : sk < resumeFrom)) {
        resumeFrom = sk
      }
    }
  }

  return {
    rows: matched.slice(0, opts.limit),
    // A spent budget is reported as "more available" rather than as the end
    // of the data: the page is short, but its cursor still leads somewhere.
    hasMore: matched.length > opts.limit || budgetSpent,
    resumeFrom,
  }
}
