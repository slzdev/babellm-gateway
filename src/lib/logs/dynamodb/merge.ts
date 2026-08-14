import 'server-only'

/**
 * Bounds what one page of the log viewer can cost. A FilterExpression is
 * applied after Limit, so a narrow filter over a wide range can read a great
 * deal and match almost nothing.
 *
 * One round trip fetches every still-hungry shard in parallel — up to
 * shards.length queries. The per-shard Limit the driver passes differs by
 * query shape (see FILTERED_SHARD_LIMIT in index.ts): unfiltered, it is small
 * (roughly 4-11 items per shard) because every scanned item is also a
 * candidate row, so ScannedCount can never approach MAX_ITEMS_EXAMINED at
 * that Limit — MAX_ROUND_TRIPS is what ends a truncated unfiltered page.
 * Filtered, the Limit is far larger (250) because DynamoDB reads up to 1 MB
 * server-side regardless of Limit once a FilterExpression is present, so
 * raising it costs the same round trip while making MAX_ITEMS_EXAMINED
 * reachable within a handful of rounds — that is the case this budget is
 * actually sized for. MAX_ROUND_TRIPS remains a backstop against
 * pathologically many round trips either way, not the primary budget for a
 * filtered query.
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
   * Set only when the budget was spent (see the drain in collectPage below).
   * Meaningful when `rows` came back empty: without it, a budget-truncated
   * page that matched nothing yet is indistinguishable from a genuinely
   * empty result (see query() in index.ts). Null otherwise — including when
   * every shard is exhausted, since there is nothing left to resume from.
   *
   * This is `floor`: the extremum, across shards that are not exhausted, of
   * their own lastEvaluatedKey.sk (max when descending, min when
   * ascending). It is *not* simply "wherever scanning stopped" — see the
   * drain's doc comment for why a naive version of that claim can skip a
   * row, and why floor itself is the safe cutoff once the drain has run.
   */
  resumeFrom: string | null
}

function stopKeyOf(key: Record<string, unknown> | undefined): string | undefined {
  const sk = key?.sk
  return typeof sk === 'string' ? sk : undefined
}

/** The shard whose buffered head is furthest along in the paging direction —
 * shared by the main loop and the drain below so the two pick winners by the
 * exact same rule. */
function pickBest<T extends ShardItem>(
  candidates: readonly { buffer: T[] }[],
  descending: boolean,
): { buffer: T[] } {
  let best = candidates[0]
  for (const s of candidates) {
    const better = descending ? s.buffer[0].sk > best.buffer[0].sk : s.buffer[0].sk < best.buffer[0].sk
    if (better) best = s
  }
  return best
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

    matched.push(pickBest(ready, opts.descending).buffer.shift() as T)
  }

  let resumeFrom: string | null = null

  if (budgetSpent) {
    // floor: the extremum, across shards that are not exhausted, of their
    // own lastEvaluatedKey.sk. DynamoDB's ExclusiveStartKey semantics mean
    // a non-exhausted shard S has examined everything down to its own
    // continuation key c_S, and every row of S it has *not* yet seen has an
    // sk strictly beyond c_S in the paging direction (descending: strictly
    // less). Since floor is the extremum of every c_S, that holds for every
    // non-exhausted shard at once: nothing anywhere still unexamined can
    // reach floor, let alone cross it. (Every shard was fetched at least
    // once in round one regardless of budget, so no non-exhausted shard is
    // missing a real continuation key here.)
    let floor: string | null = null
    for (const s of state) {
      if (s.exhausted) continue
      const sk = stopKeyOf(s.startKey)
      if (sk === undefined) continue
      if (floor === null || (opts.descending ? sk > floor : sk < floor)) floor = sk
    }

    // Drain: some shards may already be holding real, already-fetched
    // matches in their buffer — the main loop above only re-fetches a shard
    // once its buffer is empty, so a shard that found something early can
    // sit untouched while a different shard alone burns the rest of the
    // budget on filtered-empty pages. Those buffered rows were paid for and
    // must not be thrown away with the rest of this call's state.
    //
    // A buffered row is safe to emit once its sk is at or beyond floor: floor
    // is the point past which *nothing* unexamined can reach (see above), so
    // nothing still out there can outrank or tie it. That's `>=`, not `>` —
    // DynamoDB's lastEvaluatedKey is the key of the last item *examined*,
    // inclusive, so when that item passed the filter it is also the last
    // element of its own shard's buffer: a shard's own boundary row can sit
    // exactly at floor, and excluding it with a strict `>` would orphan it
    // the same way an unguarded resumeFrom would (the next query's `hi`
    // becomes floor, and boundsFor excludes the cursor value itself).
    //
    // No further fetches happen here — the budget is spent — so a shard
    // that empties out mid-drain simply stops being a candidate, even if it
    // isn't exhausted; whatever it still holds beyond floor, if anything,
    // waits for the next call.
    // Fails closed on a null floor rather than admitting everything: today
    // floor is never null here (budgetSpent requires a non-exhausted shard,
    // which always contributes one), but a floor with nothing to compare
    // against means nothing is provably safe, so the conservative answer is
    // to drain nothing rather than drain unguarded.
    const beyondFloor = (sk: string) => (
      floor !== null && (opts.descending ? sk >= floor : sk <= floor)
    )
    while (matched.length < want) {
      const candidates = state.filter((s) => s.buffer.length > 0 && beyondFloor(s.buffer[0].sk))
      if (candidates.length === 0) break
      matched.push(pickBest(candidates, opts.descending).buffer.shift() as T)
    }

    resumeFrom = floor
  }

  return {
    rows: matched.slice(0, opts.limit),
    // A spent budget is reported as "more available" rather than as the end
    // of the data: the page is short, but its cursor still leads somewhere.
    hasMore: matched.length > opts.limit || budgetSpent,
    resumeFrom,
  }
}
