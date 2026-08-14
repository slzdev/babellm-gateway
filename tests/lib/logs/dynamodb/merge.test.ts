import { expect, test } from 'vitest'
import { MAX_ROUND_TRIPS, collectPage } from '@/lib/logs/dynamodb/merge'
import type { ShardFetch, ShardItem } from '@/lib/logs/dynamodb/merge'

/**
 * A fake shard source. `pages[shard]` is the list of pages that shard hands
 * back in order; the last one carries no continuation key.
 *
 * A fake rather than DynamoDB Local because the whole point of these tests is
 * to control where page boundaries fall. Against a real store the boundaries
 * are whatever the engine chooses, and a merge bug that only shows up on an
 * uneven split would pass every run.
 *
 * A page is normally just the ids it returns, with `scanned` inferred as the
 * same count and `stop` (the sk a real LastEvaluatedKey would carry) inferred
 * as the last id — realistic when the last item DynamoDB examined is also the
 * last one that passed the filter. Passing the object form decouples `scanned`
 * from the items (what a real FilterExpression does) and `stop` from the
 * items (what a real FilterExpression does when the *last* item examined is
 * the one filtered out — the page's `items` end before `stop` does).
 */
type FakePage = string[] | { items: string[]; scanned?: number; stop?: string }

function fakeFetch(pages: Record<string, FakePage[]>): {
  fetch: ShardFetch<ShardItem>
  calls: () => number
} {
  let calls = 0

  const fetch: ShardFetch<ShardItem> = async (shard, startKey) => {
    calls += 1
    if (startKey !== undefined) {
      // Both shards would otherwise hand back an identical { at: n } shape,
      // so a merge that crossed one shard's continuation key into another
      // shard's query would be indistinguishable from a correct one.
      expect(startKey.shard).toBe(shard)
    }
    const all = pages[shard] ?? []
    // The page index comes from the key the merge hands back, not from a
    // private cursor — otherwise the fake supplies the pagination the module
    // is supposed to supply, and a merge that never forwards the
    // continuation key passes every test in this file.
    const n = startKey === undefined ? 0 : (startKey.at as number) + 1
    const raw = all[n] ?? []
    const page = Array.isArray(raw) ? { items: raw, scanned: raw.length } : raw
    const items = page.items
    const scanned = page.scanned ?? items.length
    // A synthesized, distinct-per-page stop when the page defines none —
    // still a real, assertable string, the same way DynamoDB's own
    // LastEvaluatedKey is real even on a page with no returned items.
    const stop = 'stop' in page && page.stop !== undefined
      ? page.stop
      : (items.length ? items[items.length - 1] : `${shard}-stop-${n}`)
    return {
      items: items.map((sk) => ({ sk })),
      scanned,
      lastEvaluatedKey: n + 1 < all.length ? { shard, at: n, sk: stop } : undefined,
    }
  }

  return { fetch, calls: () => calls }
}

const SHARDS = ['log#0', 'log#1']

test('merges shards into one descending run', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['f', 'd', 'b']],
    'log#1': [['e', 'c', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 6, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['f', 'e', 'd', 'c', 'b', 'a'])
  expect(out.hasMore).toBe(false)
})

test('merges ascending when paging backwards', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['a', 'c', 'e']],
    'log#1': [['b', 'd', 'f']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 6, descending: false, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
})

test('never emits a row a lagging shard could still outrank', async () => {
  // The frontier invariant. log#1 holds the global best but returns it on a
  // later page. An implementation that emitted log#0's buffer greedily would
  // return d,c,b — losing z entirely and corrupting the cursor.
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c', 'b']],
    'log#1': [[], ['z', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 3, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['z', 'd', 'c'])
  expect(out.hasMore).toBe(true)
})

test('keeps fetching a shard whose page was filtered empty', async () => {
  // A FilterExpression is applied after Limit, so DynamoDB routinely returns
  // an empty page with a continuation key. Treating that as exhausted would
  // silently drop everything behind it.
  const { fetch } = fakeFetch({
    'log#0': [[], [], ['c', 'a']],
    'log#1': [['b']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 5, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['c', 'b', 'a'])
  expect(out.hasMore).toBe(false)
})

test('excluded ids are dropped from the merge', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c']],
    'log#1': [['b', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 5, descending: true, exclude: ['c', 'a'],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['d', 'b'])
})

test('hasMore is set by the extra row, which is not returned', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c']],
    'log#1': [['b', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 2, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['d', 'c'])
  expect(out.hasMore).toBe(true)
})

test('a spent round-trip budget ends the page rather than looping', async () => {
  // An endlessly-filtering shard must not spin. The page comes back short
  // with hasMore set, so paging still works — the documented difference from
  // the Postgres store.
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch, calls } = fakeFetch({ 'log#0': empty, 'log#1': empty })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(calls()).toBe(MAX_ROUND_TRIPS * SHARDS.length)
})

test('an empty store yields an empty page with no more', async () => {
  const { fetch } = fakeFetch({})

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(false)
})

test('resumeFrom is the max stopping point across shards when descending', async () => {
  // Both shards are filtered empty the whole way through, so neither buffer
  // ever holds anything — the case that matters, and the one the budget
  // trips on in practice (see the "not exotic" example in merge.ts's docs).
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch } = fakeFetch({ 'log#0': empty, 'log#1': empty })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  // Every fake page's synthesized stop key is `${shard}-stop-${n}`, and both
  // shards get MAX_ROUND_TRIPS fetches (the round-trip budget trips before
  // the item budget here, since every page is empty). Lexically,
  // "log#1-stop-39" > "log#0-stop-39", so log#1's last stop key wins the max.
  expect(out.resumeFrom).toBe(`log#1-stop-${MAX_ROUND_TRIPS - 1}`)
})

test('resumeFrom is the min stopping point across shards when ascending', async () => {
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch } = fakeFetch({ 'log#0': empty, 'log#1': empty })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: false, exclude: [],
  })

  expect(out.resumeFrom).toBe(`log#0-stop-${MAX_ROUND_TRIPS - 1}`)
})

test('resumeFrom is null when every shard is exhausted', async () => {
  const { fetch } = fakeFetch({
    'log#0': [['d', 'c']],
    'log#1': [['b', 'a']],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.hasMore).toBe(false)
  expect(out.resumeFrom).toBeNull()
})

test('an empty but unexhausted page contributes its own stopping point', async () => {
  // The central case: a page with zero items still carries a continuation
  // key (a heavy scanned count, not the page count, trips the budget after
  // one round here), and that key — not "nothing left" — is what
  // resumeFrom must report. This is what lets the caller resume a page that
  // would otherwise render as "no matching logs" with matches sitting just
  // past where scanning gave up.
  const heavy = { items: [], scanned: 6_000, stop: 'far-along' }
  const { fetch } = fakeFetch({
    'log#0': [heavy, []],
    'log#1': [heavy, []],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('far-along')
})

test('resumeFrom is null when a shard has an unconsumed match stuck in its buffer', async () => {
  // The counterexample that rules out the naive "extremum of continuation
  // keys alone" formula: log#0 finds a real match on its very first fetch
  // and is then never re-fetched (the loop only re-fetches shards with an
  // empty buffer), while log#1 alone burns through the whole round-trip
  // budget returning nothing. Emission never runs (log#1 is still hungry
  // every round), so rows comes back empty — but log#0's buffered 'x' is a
  // real match, sitting above (newer than) log#0's own lastEvaluatedKey. If
  // resumeFrom used that lastEvaluatedKey, the next query's upper bound
  // would exclude 'x' forever. Losing the cursor here (falling back to
  // null) is the safe outcome; skipping 'x' would not be.
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch } = fakeFetch({
    'log#0': [['x'], []],
    'log#1': empty,
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBeNull()
})

test('resumeFrom and non-empty rows can coexist', async () => {
  // want = limit+1 = 2. log#0 is exhausted right after its one item; log#1
  // also has exactly one buffered item, not exhausted (it carries a
  // continuation key). Shifting both is enough to reach `want`, so the loop
  // exits before log#1 is ever refetched — its buffer just happens to have
  // drained to empty at the same moment. So the page has a real row *and*
  // a non-null resumeFrom. This is the state a caller (query() in
  // index.ts) must not get backwards: it must still use the real row's id
  // as the cursor, not resumeFrom, whenever rows are non-empty.
  const { fetch } = fakeFetch({
    'log#0': [['z']],
    'log#1': [{ items: ['b'], stop: 'a' }, []],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 1, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['z'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('a')
})

test('a large scanned count trips the budget even when nothing is returned', async () => {
  // A narrow filter over a wide range can scan thousands of items while
  // returning almost none of them. The budget must react to what DynamoDB
  // read (scanned), not to what came back — otherwise a filtered query would
  // look "cheap" and this exact scenario would go unbounded.
  const heavyFilter = { items: [], scanned: 5_000 }
  const { fetch, calls } = fakeFetch({
    'log#0': [heavyFilter, heavyFilter],
    'log#1': [heavyFilter, heavyFilter],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  // Two shards scanning 5,000 apiece cross MAX_ITEMS_EXAMINED (10,000) after
  // a single round trip — far short of MAX_ROUND_TRIPS. If the budget
  // counted returned items instead, nothing would trip here until both
  // shards ran out of pages on their own, two round trips later.
  expect(calls()).toBe(2)
})
