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
 * Draws the whole chain by repeated cumulative-weight pick without
 * replacement, so failover order is weighted too. Weighting only the first
 * pick would collapse the distribution onto whichever target sorts first
 * exactly when something is failing.
 *
 * Non-positive weights are appended in input order rather than dropped: a
 * weight of 0 reads as "prefer never", and dropping it would leave a model
 * whose targets are all zero with nothing to try.
 */
function weightedOrder(candidates: Candidate[], random: () => number): Candidate[] {
  const pool = candidates.filter((c) => c.weight > 0)
  const rest = candidates.filter((c) => c.weight <= 0)
  const order: Candidate[] = []

  while (pool.length > 0) {
    if (pool.length === 1) {
      order.push(pool.pop()!)
      break
    }

    const total = pool.reduce((sum, c) => sum + c.weight, 0)
    let roll = random() * total
    // Defaulting to the last index rather than -1 means a roll that floating
    // point leaves fractionally above the running total picks the final
    // bucket instead of nothing.
    let index = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      roll -= pool[i].weight
      if (roll < 0) {
        index = i
        break
      }
    }
    order.push(pool.splice(index, 1)[0])
  }

  return [...order, ...rest]
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
  deps: Partial<SelectDeps> = {},
): Candidate[] {
  if (candidates.length === 0) return []

  const { random = Math.random } = deps
  const ordered =
    model.policy === 'weighted' ? weightedOrder(candidates, random) : candidates

  // max_attempts is a bare integer column, so a 0 or a negative is storable.
  // One attempt is the smallest number that still asks a provider anything.
  return ordered.slice(0, Math.max(1, model.maxAttempts))
}
