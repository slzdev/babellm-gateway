import { expect, test } from 'vitest'
import { selectOrder, type SelectableModel } from '@/lib/gateway/select'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ProviderRow } from '@/lib/db/schema'

/**
 * selectOrder only ever reads `name` off the provider, so the rest of the row
 * is stubbed rather than built — these tests deliberately touch no database.
 */
function candidate(name: string, weight = 100, priority = 0): Candidate {
  return {
    targetId: `target-${name}`,
    provider: { name } as ProviderRow,
    upstreamModel: `${name}-model`,
    priority,
    weight,
    serviceTier: null,
  }
}

function model(patch: Partial<SelectableModel> = {}): SelectableModel {
  return { id: 'vm-1', policy: 'failover', maxAttempts: 3, ...patch }
}

const names = (chain: Candidate[]) => chain.map((c) => c.provider.name)

test('failover keeps the order it was given', () => {
  const chain = selectOrder([candidate('a'), candidate('b'), candidate('c')], model())
  expect(names(chain)).toEqual(['a', 'b', 'c'])
})

test('the chain is capped at max_attempts', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
    model({ maxAttempts: 2 }),
  )
  expect(names(chain)).toEqual(['a', 'b'])
})

test('a chain shorter than max_attempts is not padded', () => {
  const chain = selectOrder([candidate('a')], model({ maxAttempts: 5 }))
  expect(names(chain)).toEqual(['a'])
})

test('a nonsensical max_attempts still yields one attempt rather than none', () => {
  // The column is a plain integer with no check constraint, so 0 is storable.
  // Returning an empty chain would turn a misconfiguration into a request
  // that fails without ever contacting a provider.
  expect(selectOrder([candidate('a'), candidate('b')], model({ maxAttempts: 0 })))
    .toHaveLength(1)
})

test('the input array is never mutated', () => {
  const input = [candidate('a'), candidate('b')]
  const copy = [...input]
  selectOrder(input, model({ policy: 'weighted' }), { random: () => 0.5 })
  expect(input).toEqual(copy)
})

test('an empty candidate list yields an empty chain rather than throwing', () => {
  expect(selectOrder([], model())).toEqual([])
})

// Weighted selection draws without replacement, so each pick consumes one
// `random()` value against the *remaining* pool's total. A queue of rolls
// makes each draw's bucket explicit rather than depending on Math.random.
function rolls(...values: number[]) {
  const queue = [...values]
  return () => queue.shift() ?? 0
}

test('weighted picks the bucket the roll lands in', () => {
  // Weights 10/20/70 over a total of 100 give buckets a=[0,10), b=[10,30),
  // c=[30,100). A roll of 0.5 lands at 50, inside c.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['c'])
})

test('a roll at the very start of the range picks the first target', () => {
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0) },
  )
  expect(names(chain)).toEqual(['a'])
})

test('a roll at the top of the range picks the last target rather than falling off', () => {
  // Floating-point accumulation can leave the running total a hair short of
  // the roll, so the last bucket must be the fallback rather than undefined.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 1 }),
    { random: rolls(0.999999999) },
  )
  expect(names(chain)).toEqual(['c'])
})

test('the whole chain is weighted, not just its head', () => {
  // First draw: total 100, roll 0.05 -> 5 -> a. Remaining pool b(20) c(70),
  // total 90, roll 0.5 -> 45 -> lands past b's [0,20) into c.
  const chain = selectOrder(
    [candidate('a', 10), candidate('b', 20), candidate('c', 70)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.05, 0.5) },
  )
  expect(names(chain)).toEqual(['a', 'c', 'b'])
})

test('every target appears exactly once — draws are without replacement', () => {
  const chain = selectOrder(
    [candidate('a', 1), candidate('b', 1), candidate('c', 1), candidate('d', 1)],
    model({ policy: 'weighted', maxAttempts: 10 }),
    { random: rolls(0.9, 0.9, 0.9, 0.9) },
  )
  expect([...names(chain)].sort()).toEqual(['a', 'b', 'c', 'd'])
})

test('a zero-weight target sorts last instead of being dropped', () => {
  // Weight 0 most plausibly means "prefer never", not "delete". Dropping it
  // would turn a weight edit into a silent capacity cut, and a model whose
  // targets are all zero would have no targets at all.
  const chain = selectOrder(
    [candidate('cheap', 0), candidate('a', 50), candidate('b', 50)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.9, 0.9) },
  )
  expect(names(chain).at(-1)).toBe('cheap')
  expect(names(chain)).toHaveLength(3)
})

test('a negative weight is treated as zero, not as a negative probability', () => {
  const chain = selectOrder(
    [candidate('bad', -5), candidate('a', 100)],
    model({ policy: 'weighted', maxAttempts: 2 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['a', 'bad'])
})

test('all-zero weights still produce a usable chain in input order', () => {
  const chain = selectOrder(
    [candidate('a', 0), candidate('b', 0)],
    model({ policy: 'weighted', maxAttempts: 2 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['a', 'b'])
})

test('a single weighted candidate needs no roll at all', () => {
  const chain = selectOrder(
    [candidate('only', 100)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: () => { throw new Error('random() should not be needed') } },
  )
  expect(names(chain)).toEqual(['only'])
})

function cursorOf(value: number) {
  return () => value
}

test('round robin rotates the eligible list by the cursor', () => {
  const targets = [candidate('a'), candidate('b'), candidate('c')]
  const rr = model({ policy: 'round_robin', maxAttempts: 3 })

  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(0) })))
    .toEqual(['a', 'b', 'c'])
  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(1) })))
    .toEqual(['b', 'c', 'a'])
  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(2) })))
    .toEqual(['c', 'a', 'b'])
})

test('a cursor past the end of the list wraps', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'round_robin', maxAttempts: 3 }),
    { nextCursor: cursorOf(7) },
  )
  expect(names(chain)).toEqual(['b', 'c', 'a'])
})

test('round robin is asked for the cursor of the model being routed', () => {
  const seen: string[] = []
  selectOrder(
    [candidate('a'), candidate('b')],
    model({ id: 'vm-42', policy: 'round_robin' }),
    { nextCursor: (id) => { seen.push(id); return 0 } },
  )
  expect(seen).toEqual(['vm-42'])
})

test('round robin still respects max_attempts after rotating', () => {
  const chain = selectOrder(
    [candidate('a'), candidate('b'), candidate('c')],
    model({ policy: 'round_robin', maxAttempts: 2 }),
    { nextCursor: cursorOf(1) },
  )
  expect(names(chain)).toEqual(['b', 'c'])
})

test('failover and weighted never touch the cursor', () => {
  const nextCursor = () => { throw new Error('cursor should not be consulted') }

  expect(() => selectOrder([candidate('a')], model(), { nextCursor })).not.toThrow()
  expect(() =>
    selectOrder([candidate('a', 1), candidate('b', 1)], model({ policy: 'weighted' }), {
      nextCursor,
      random: () => 0.5,
    }),
  ).not.toThrow()
})

// Priority splits the eligible targets into tiers. The policy orders targets
// *within* a tier; tiers themselves always run lowest-priority-first, so a
// cheap or experimental tier can be tried before falling back to a redundant
// one. Every candidate defaulting to priority 0 leaves a single tier, which is
// why all the tests above still describe the whole chain.

test('weighted draws within a tier and never promotes across one', () => {
  // One flex target at priority 0, two default-tier targets at priority 1.
  // Whatever the roll, the flex target is attempted first.
  const targets = [
    candidate('flex', 100, 0),
    candidate('groq', 50, 1),
    candidate('bedrock', 50, 1),
  ]
  const weighted = model({ policy: 'weighted', maxAttempts: 3 })

  // Tier 1 totals 100, so buckets are groq=[0,50) bedrock=[50,100).
  expect(names(selectOrder(targets, weighted, { random: rolls(0.9) })))
    .toEqual(['flex', 'bedrock', 'groq'])
  expect(names(selectOrder(targets, weighted, { random: rolls(0.1) })))
    .toEqual(['flex', 'groq', 'bedrock'])
})

test('a weighted tier is exhausted before the next tier is tried', () => {
  const chain = selectOrder(
    [candidate('a', 50, 0), candidate('b', 50, 0), candidate('c', 100, 1)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.9) },
  )
  expect(names(chain).slice(0, 2).sort()).toEqual(['a', 'b'])
  expect(names(chain).at(-1)).toBe('c')
})

test('a zero-weight target sinks to the end of its own tier, not of the chain', () => {
  // Sinking it past a higher-priority tier would invert the tier order that
  // priority exists to express.
  const chain = selectOrder(
    [candidate('cheap', 0, 0), candidate('a', 50, 0), candidate('b', 100, 1)],
    model({ policy: 'weighted', maxAttempts: 3 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['a', 'cheap', 'b'])
})

test('round robin rotates inside each tier rather than across the whole list', () => {
  const targets = [
    candidate('a', 100, 0), candidate('b', 100, 0),
    candidate('c', 100, 1), candidate('d', 100, 1),
  ]
  const rr = model({ policy: 'round_robin', maxAttempts: 4 })

  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(0) })))
    .toEqual(['a', 'b', 'c', 'd'])
  expect(names(selectOrder(targets, rr, { nextCursor: cursorOf(1) })))
    .toEqual(['b', 'a', 'd', 'c'])
})

test('round robin reads the cursor once per request however many tiers there are', () => {
  // Reading it per tier would advance the rotation several steps per request,
  // so a two-tier model would cycle at a different rate from a one-tier one.
  let reads = 0
  selectOrder(
    [candidate('a', 100, 0), candidate('b', 100, 1), candidate('c', 100, 2)],
    model({ policy: 'round_robin', maxAttempts: 3 }),
    { nextCursor: () => { reads += 1; return 1 } },
  )
  expect(reads).toBe(1)
})

test('round robin rotates a tier by its own length', () => {
  // A cursor of 1 has nothing to rotate in a single-target tier; the longer
  // tier still advances.
  const chain = selectOrder(
    [candidate('solo', 100, 0), candidate('a', 100, 1), candidate('b', 100, 1)],
    model({ policy: 'round_robin', maxAttempts: 3 }),
    { nextCursor: cursorOf(1) },
  )
  expect(names(chain)).toEqual(['solo', 'b', 'a'])
})

test('failover with distinct priorities is the flat list it always was', () => {
  // Grouping then concatenating must be a no-op here: failover leaves each
  // tier in the (priority, createdAt, id) order resolveVirtualModel supplied.
  const chain = selectOrder(
    [candidate('a', 100, 0), candidate('b', 100, 1), candidate('c', 100, 2)],
    model({ policy: 'failover', maxAttempts: 3 }),
  )
  expect(names(chain)).toEqual(['a', 'b', 'c'])
})

test('max_attempts can cut the chain before a later tier is ever reached', () => {
  // Tier order does not buy a tier an attempt: the cap still applies to the
  // flattened chain, so a fat first tier starves the fallback tier.
  const chain = selectOrder(
    [
      candidate('a', 100, 0), candidate('b', 100, 0), candidate('c', 100, 0),
      candidate('fallback', 100, 1),
    ],
    model({ policy: 'failover', maxAttempts: 3 }),
  )
  expect(names(chain)).toEqual(['a', 'b', 'c'])
})

test('negative priorities tier ahead of the default', () => {
  // priority is a bare integer column and accepts negatives, which is the
  // natural way to put a target in front of everything already configured.
  const chain = selectOrder(
    [candidate('urgent', 100, -1), candidate('normal', 100, 0)],
    model({ policy: 'weighted', maxAttempts: 2 }),
    { random: rolls(0.5) },
  )
  expect(names(chain)).toEqual(['urgent', 'normal'])
})
