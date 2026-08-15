import type { Candidate } from './resolve'
import { nextCursor as defaultNextCursor } from './rr-cursor'

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
 * Splits the candidates into priority tiers. They arrive sorted by
 * (priority, createdAt, id), so a tier is a contiguous run and grouping needs
 * no second sort.
 */
function tiersOf(candidates: Candidate[]): Candidate[][] {
  const tiers: Candidate[][] = []

  for (const candidate of candidates) {
    const current = tiers.at(-1)
    if (current && current[0].priority === candidate.priority) current.push(candidate)
    else tiers.push([candidate])
  }

  return tiers
}

/**
 * Draws a tier by repeated cumulative-weight pick without replacement, so
 * failover order within the tier is weighted too. Weighting only the first
 * pick would collapse the distribution onto whichever target sorts first
 * exactly when something is failing.
 *
 * Non-positive weights are appended at the end of their own tier rather than
 * dropped: a weight of 0 reads as "prefer never", and dropping it would leave
 * a model whose targets are all zero with nothing to try. They stay inside the
 * tier because sinking them past a later one would invert the order priority
 * exists to express.
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
 * Rotating, rather than only moving one target to the head, keeps the rest of
 * the tier in the tie-break order every instance shares — so a request that
 * has to fail over still walks a predictable sequence.
 */
function rotate(candidates: Candidate[], cursor: number): Candidate[] {
  const offset = ((cursor % candidates.length) + candidates.length) % candidates.length
  return [...candidates.slice(offset), ...candidates.slice(0, offset)]
}

/**
 * Orders every eligible target into the chain the attempt loop will walk.
 * Pure: the caller injects randomness and the round-robin cursor, which is
 * what makes weighted and round-robin selection testable at all.
 *
 * `candidates` arrives already filtered to enabled targets on enabled
 * providers and already sorted by (priority, createdAt, id) — see
 * resolveVirtualModel. That tie-break is load-bearing for round robin.
 *
 * Priority and policy are orthogonal: priority splits the targets into tiers
 * that are always walked lowest-first, and the policy only decides the order
 * *within* a tier. So a model can try a cheap tier before falling back to a
 * redundant one spread across providers. Targets default to priority 0, which
 * leaves a single tier and the behaviour each policy had on its own.
 */
export function selectOrder(
  candidates: Candidate[],
  model: SelectableModel,
  deps: Partial<SelectDeps> = {},
): Candidate[] {
  if (candidates.length === 0) return []

  const { random = Math.random, nextCursor = defaultNextCursor } = deps
  // Read once per request rather than once per tier: advancing the cursor per
  // tier would make how fast a model cycles depend on how it happens to be
  // tiered, and skip positions in the tiers that are shorter.
  const cursor = model.policy === 'round_robin' ? nextCursor(model.id) : 0

  const ordered = tiersOf(candidates).flatMap((tier) =>
    model.policy === 'weighted' ? weightedOrder(tier, random)
    : model.policy === 'round_robin' ? rotate(tier, cursor)
    : tier,
  )

  // max_attempts is a bare integer column, so a 0 or a negative is storable.
  // One attempt is the smallest number that still asks a provider anything.
  // It caps the flattened chain, so a fat first tier can starve a later one.
  return ordered.slice(0, Math.max(1, model.maxAttempts))
}
