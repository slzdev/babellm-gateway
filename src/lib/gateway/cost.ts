import type { CostBreakdown } from '@/lib/logs/types'

/**
 * The wire shape of a request's cost.
 *
 * Deliberately narrower than CostBreakdown: the catalog's per-Mtok rates stay
 * out of it. Clients see what they were charged and how it splits; the rates
 * that produced those numbers are the operator's business and stay in the
 * request log and the admin UI.
 *
 * Money is a string at nine decimals, matching what computeCost produces and
 * what the log stores. Numbers would reintroduce, at the client, exactly the
 * float error the string representation exists to avoid.
 */
export interface CostPayload {
  currency: 'USD'
  input: string | null
  cached: string | null
  output: string | null
  total: string | null
}

/**
 * Renders a computed cost for the client, or null when the request could not
 * be priced.
 *
 * Null propagates rather than collapsing to zeroes, for the reason
 * `computeCost` returns null in the first place: a response claiming $0.00 for
 * an uncatalogued model is lying.
 */
export function costPayload(cost: CostBreakdown | null): CostPayload | null {
  if (!cost) return null
  return {
    currency: 'USD',
    input: cost.inputUsd,
    cached: cost.cachedUsd,
    output: cost.outputUsd,
    total: cost.totalUsd,
  }
}

/**
 * Writes the cost into a response's `usage` object.
 *
 * A target with no usage is returned untouched. An absent usage object means
 * the provider measured nothing — a clone that omits the field, or one
 * configured with disableStreamUsage — and inventing one to carry a null cost
 * would report a measurement that was never taken.
 *
 * The cast is deliberate and confined here. `ChatCompletion`,
 * `ChatCompletionChunk` and `Response` are the OpenAI SDK's own types and
 * cannot express this extension; keeping the one cast in this function stops
 * it spreading through the ingresses.
 *
 * Constrained to `T extends object` rather than `T extends { usage?: unknown }`:
 * the narrower constraint trips TypeScript's weak-type-detection check
 * (TS2559) whenever T is inferred from an object with no properties in
 * common with `{ usage?: unknown }` — exactly the shape of a response with no
 * usage field at all. The `usage` access below is cast instead, so callers
 * with a real `usage?: ...` field still get the same inference.
 */
export function withUsageCost<T extends object>(
  target: T,
  cost: CostPayload | null,
): T {
  const usage = (target as { usage?: unknown }).usage
  if (!usage) return target
  return { ...target, usage: { ...(usage as object), cost } } as T
}
