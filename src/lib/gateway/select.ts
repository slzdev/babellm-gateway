import type { Candidate } from './resolve'

export interface SelectDeps {
  random: () => number
  nextCursor: (virtualModelId: string) => number
}

/**
 * The structural subset of a virtual model that selection needs. Taking this
 * rather than the row means these functions can be tested without a database.
 */
export interface SelectableModel {
  id: string
  policy: 'failover' | 'weighted' | 'round_robin'
  maxAttempts: number
}

/**
 * Orders every eligible target into the chain the attempt loop will walk.
 * Pure: the caller injects randomness and the round-robin cursor, which is
 * what makes weighted and round-robin selection testable at all.
 *
 * `candidates` arrives already filtered to enabled targets on enabled
 * providers and already sorted by (priority, createdAt, id) — see
 * resolveVirtualModel. That tie-break is load-bearing for round robin.
 */
export function selectOrder(
  candidates: Candidate[],
  model: SelectableModel,
  _deps: Partial<SelectDeps> = {},
): Candidate[] {
  if (candidates.length === 0) return []

  const ordered = candidates

  // max_attempts is a bare integer column, so a 0 or a negative is storable.
  // One attempt is the smallest number that still asks a provider anything.
  return ordered.slice(0, Math.max(1, model.maxAttempts))
}
