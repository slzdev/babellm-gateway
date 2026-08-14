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

/** A single Query response's ScannedCount can never exceed its Limit — see
 * FILTERED_SHARD_LIMIT in dynamodb/index.ts, which uses 250 for a filtered
 * query, the largest Limit the real driver ever passes. A single fake page
 * claiming to have scanned thousands of items is a shape DynamoDB could never
 * hand back; these tests instead spend the item budget across this many
 * pages, so they exercise page shapes the real driver can actually produce. */
const REALISTIC_FILTERED_SCANNED = 250

/** `rounds` identical heavy, filtered-empty, unexhausted pages, followed by
 * one more so the shard is never accidentally reported exhausted on the exact
 * round a test inspects it. */
function heavyRun(rounds: number, stop: string): FakePage[] {
  return [
    ...Array.from({ length: rounds }, () => ({ items: [], scanned: REALISTIC_FILTERED_SCANNED, stop })),
    [],
  ]
}

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
  // Both shards are filtered empty the whole way through, so neither buffer
  // ever holds anything and the drain has no candidates — rows and hasMore
  // should look exactly like the descending mirror above, just with the
  // opposite extremum for resumeFrom.
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch } = fakeFetch({ 'log#0': empty, 'log#1': empty })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: false, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe(`log#0-stop-${MAX_ROUND_TRIPS - 1}`)
})

test('an exhausted shard is excluded from floor but its buffered match still drains', async () => {
  // Regression fixture for the old, too-weak version of this test: that one
  // had every shard exhausted after a single page, which means budgetSpent
  // is false (the loop finishes normally) and resumeFrom is null via the
  // outer `if (budgetSpent)` guard alone — the exhausted-shard rule inside
  // floor's computation was never actually exercised, and removing it left
  // the test green.
  //
  // Here the budget genuinely is spent, and the shards are a genuine mix:
  // log#0 is exhausted after one page but still has a real match ('z')
  // sitting in its buffer; log#1 alone stays hungry every round after that —
  // its filtered-empty pages, each capped at a realistic Limit, spend the
  // whole item budget over many rounds and it is left not exhausted, at
  // continuation 'm'; log#2 is exhausted immediately (nothing there at all).
  // floor must come only from log#1 — the sole non-exhausted shard — and
  // log#0's own exhausted status must not block its buffered 'z' from
  // draining: 'z' is beyond floor regardless of whether log#0 itself ever
  // contributes to it.
  const shards = ['log#0', 'log#1', 'log#2']
  const { fetch } = fakeFetch({
    'log#0': [['z']],
    // log#0 and log#2 are fetched once, in round one, and then stop being
    // hungry (buffer non-empty / exhausted), so log#1 alone accumulates
    // examined count every round after that — 40 rounds of 250 crosses
    // MAX_ITEMS_EXAMINED.
    'log#1': heavyRun(40, 'm'),
    'log#2': [[]],
  })

  const out = await collectPage({
    fetch, shards, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['z'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('m')
})

test('an empty but unexhausted page contributes its own stopping point', async () => {
  // The central case: a page with zero items still carries a continuation
  // key, and that key — not "nothing left" — is what resumeFrom must report.
  // This is what lets the caller resume a page that would otherwise render as
  // "no matching logs" with matches sitting just past where scanning gave up.
  // Both shards stay hungry every round (every page is filtered-empty), so
  // together they spend 500/round; 20 rounds crosses MAX_ITEMS_EXAMINED —
  // well under the 40-round backstop, so the item cap is unambiguously what
  // ends this page.
  const { fetch } = fakeFetch({
    'log#0': heavyRun(20, 'far-along'),
    'log#1': heavyRun(20, 'far-along'),
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('far-along')
})

test('a buffered match is drained and returned instead of being lost to a budget-truncated page', async () => {
  // The counterexample that ruled out "resumeFrom = extremum of continuation
  // keys alone": log#0 finds a real match on its very first fetch and is
  // then never re-fetched (the loop only re-fetches shards with an empty
  // buffer), while log#1 alone burns through the whole round-trip budget
  // returning nothing. Naively resuming past log#0's own lastEvaluatedKey
  // would exclude the buffered 'x' forever. The drain fixes this by emitting
  // 'x' now, since it's already fetched and provably the global next row.
  //
  // This also exercises the floor boundary precisely: log#0's page is
  // `['x']`, so the fake's synthesized lastEvaluatedKey.sk for that page is
  // 'x' itself — the same value as the buffered item, exactly the case where
  // DynamoDB's last *examined* item is also the last one that passed the
  // filter. floor ends up 'x' too (log#0's continuation key beats log#1's),
  // so the drain must admit a candidate with sk *equal* to floor, not only
  // strictly beyond it — proving the guard is `>=`, not `>`.
  const empty: string[][] = Array.from({ length: 500 }, () => [])
  const { fetch } = fakeFetch({
    'log#0': [['x'], []],
    'log#1': empty,
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['x'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('x')
})

test('the drain picks the global-best candidate across shards, not the first one', async () => {
  // Every other budget-spent fixture in this file has at most one drain
  // candidate at a time, so pickBest is never actually asked to choose
  // between two — swapping it for `candidates[0]` would survive unnoticed.
  // This fixture forces a real choice, more than once, and also checks that
  // a shard below floor stays behind even while two other shards are
  // competing above it.
  //
  // log#0 buffers ['n', 'g'] with its own continuation at 'g' (the last
  // item, boundary case again). log#1 buffers ['t'] with its continuation
  // decoupled to 'b' (below both of log#0's items) via the object page
  // form — realistic: DynamoDB's FilterExpression can drop the last
  // examined item even though an earlier one in the same page matched.
  // log#2 is the only shard still hungry after round one (log#0, log#1,
  // log#3 all end round one with a non-empty buffer or exhausted), so it
  // alone accumulates examined count across the remaining rounds, ending at
  // continuation 'a' — the smallest of the three, so it never wins floor,
  // just forces the budget to trip. log#3 is exhausted with a single
  // buffered item 'c', which sits below floor and must be left behind.
  //
  // floor = max('g', 'b', 'a') = 'g'. Both log#0's 'n' and log#1's 't' are
  // >= 'g', so the drain must choose between them twice (t first, since
  // it's larger; then n; then log#0's own boundary item 'g'), while log#3's
  // 'c' never qualifies.
  const shards = ['log#0', 'log#1', 'log#2', 'log#3']
  const { fetch } = fakeFetch({
    'log#0': [['n', 'g'], []],
    'log#1': [{ items: ['t'], stop: 'b' }, []],
    'log#2': heavyRun(40, 'a'),
    'log#3': [['c']],
  })

  const out = await collectPage({
    fetch, shards, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['t', 'n', 'g'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('g')
})

test('a buffered row below floor is not drained, since something unseen could still outrank it', async () => {
  // log#0 is exhausted after one page, leaving 'g' buffered and unconsumed.
  // log#1 alone stays hungry every round after that, spending the whole item
  // budget across many filtered-empty pages capped at a realistic Limit,
  // ending not exhausted with continuation 'j'. floor is therefore 'j' — but
  // log#0's buffered 'g' is *below* floor ('g' < 'j'), meaning log#1 might
  // still hold something unseen between 'j' and 'g' that outranks it.
  // Draining 'g' anyway would be exactly the class of bug this whole design
  // exists to prevent, just moved from "lost" to "returned out of order".
  // Nothing should be emitted; only the cursor should resume.
  const { fetch } = fakeFetch({
    'log#0': [['g']],
    'log#1': heavyRun(40, 'j'),
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('j')
})

test('ascending: a buffered match at floor is drained and returned', async () => {
  // The ascending mirror of the descending boundary-drain test above. log#0
  // buffers ['c'] with its own continuation at 'c' (the boundary case: the
  // last examined item passed the filter and is also the continuation key) —
  // and, having a non-empty buffer, is never refetched, so log#1 alone
  // accumulates examined count for the rest of the run, ending at
  // continuation 'z' — well above 'c', so it never wins the ascending
  // extremum (the minimum). floor = min('c', 'z') = 'c', and log#0's
  // buffered 'c' sits exactly at floor: it must be drained under `<=`, the
  // ascending mirror of the descending `>=` guard.
  const { fetch } = fakeFetch({
    'log#0': [['c'], []],
    'log#1': heavyRun(40, 'z'),
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: false, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['c'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('c')
})

test('ascending: a buffered row above floor is not drained', async () => {
  // The ascending mirror of the descending below-floor test. log#0 is
  // exhausted after one page, leaving 'p' buffered and unconsumed — 'p' is
  // above where log#1 (the only non-exhausted shard, and the only
  // contributor to floor) has scanned to. log#1 alone stays hungry every
  // round after that, spending the whole item budget across many
  // filtered-empty pages capped at a realistic Limit, ending at continuation
  // 'j'. floor = 'j', and log#0's buffered 'p' is above it ('p' > 'j'): log#1
  // might still hold something unseen between 'j' and 'p' that belongs
  // first, so 'p' must not be drained.
  const { fetch } = fakeFetch({
    'log#0': [['p']],
    'log#1': heavyRun(40, 'j'),
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: false, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBe('j')
})

test('resumeFrom stays null when the page completes without spending the budget', async () => {
  // want = limit+1 = 2. log#0 is exhausted right after its one item; log#1
  // also has exactly one buffered item, not exhausted (it carries a
  // continuation key). Shifting both is enough to reach `want` through the
  // ordinary loop, so it exits before log#1 is ever refetched and before the
  // budget is ever spent — its buffer just happens to drain to empty at the
  // same moment. resumeFrom must not leak a value here: it is only ever set
  // when collectPage actually gave up on the budget, and a caller must keep
  // using the real last row's id as the cursor in every other case.
  const { fetch } = fakeFetch({
    'log#0': [['z']],
    'log#1': [{ items: ['b'], stop: 'a' }, []],
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 1, descending: true, exclude: [],
  })

  expect(out.rows.map((r) => r.sk)).toEqual(['z'])
  expect(out.hasMore).toBe(true)
  expect(out.resumeFrom).toBeNull()
})

test('a large scanned count trips the budget even when nothing is returned', async () => {
  // A narrow filter over a wide range can scan thousands of items while
  // returning almost none of them. The budget must react to what DynamoDB
  // read (scanned), not to what came back — otherwise a filtered query would
  // look "cheap" and this exact scenario would go unbounded. Both shards stay
  // hungry every round at a realistic per-fetch Limit (250 each), so together
  // they cross MAX_ITEMS_EXAMINED after 20 round trips — well short of the
  // 40-round backstop. If the budget counted returned items instead, nothing
  // would trip here until both shards ran out of pages on their own.
  const { fetch, calls } = fakeFetch({
    'log#0': heavyRun(20, 'stop-0'),
    'log#1': heavyRun(20, 'stop-1'),
  })

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(true)
  expect(calls()).toBe(40)
})
