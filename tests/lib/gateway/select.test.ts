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
