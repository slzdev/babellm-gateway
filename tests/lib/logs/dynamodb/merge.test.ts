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
 * same count. Passing `{ items, scanned }` instead decouples the two — which
 * is what a real FilterExpression does, and what most of these tests don't
 * need to model.
 */
type FakePage = string[] | { items: string[]; scanned: number }

function fakeFetch(pages: Record<string, FakePage[]>): {
  fetch: ShardFetch<ShardItem>
  calls: () => number
} {
  const cursor: Record<string, number> = {}
  let calls = 0

  const fetch: ShardFetch<ShardItem> = async (shard) => {
    calls += 1
    const all = pages[shard] ?? []
    const n = cursor[shard] ?? 0
    cursor[shard] = n + 1
    const raw = all[n] ?? []
    const page = Array.isArray(raw) ? { items: raw, scanned: raw.length } : raw
    return {
      items: page.items.map((sk) => ({ sk })),
      scanned: page.scanned,
      lastEvaluatedKey: n + 1 < all.length ? { at: n } : undefined,
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
  expect(calls()).toBeLessThanOrEqual(MAX_ROUND_TRIPS * SHARDS.length)
})

test('an empty store yields an empty page with no more', async () => {
  const { fetch } = fakeFetch({})

  const out = await collectPage({
    fetch, shards: SHARDS, limit: 10, descending: true, exclude: [],
  })

  expect(out.rows).toEqual([])
  expect(out.hasMore).toBe(false)
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
  // a single round trip — far short of MAX_ROUND_TRIPS (8). If the budget
  // counted returned items instead, nothing would trip here until both
  // shards ran out of pages on their own, two round trips later.
  expect(calls()).toBe(2)
})
