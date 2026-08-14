export interface UsageFilter { from: Date; to: Date; apiKeyId?: string; userId?: string; model?: string }
export interface UsageTotals {
  requests: number; errorRequests: number; unpricedRequests: number
  promptTokens: number; completionTokens: number; cachedTokens: number
  /** A string, never a number: numeric(18,9) exists so a sub-micro-dollar cost
   * does not round to zero, and parsing it into a float here would undo that
   * on the way to the page. */
  costUsd: string; avgLatencyMs: number | null; maxLatencyMs: number | null
  avgTtftMs: number | null
}
export interface UsagePoint { bucket: Date; success: number; clientError: number; serverError: number; costUsd: string }
export type BreakdownDimension = 'model' | 'key' | 'user' | 'provider'
export interface BreakdownRow { id: string | null; label: string; requests: number; errorRequests: number; tokens: number; costUsd: string }

/**
 * How many rows a breakdown table returns, cost descending.
 *
 * Spec §10 says "top rows by cost" and this is the "top". Without a cap, a
 * wide range on a busy gateway returns one row per distinct model, key, user
 * or provider that ever appeared in it, straight into the page.
 *
 * 100 rather than something tighter like 20: a breakdown table has to agree
 * with the tiles above it, and a cap that bites routinely would make it
 * disagree routinely. Past 100 distinct models — or keys, or users — a table
 * is not what anyone is reading anyway, and the table says so when the cap
 * is reached rather than letting a short list imply a complete one.
 *
 * Lives here rather than in query.ts because the table that renders it is a
 * Client Component and query.ts is `server-only`.
 */
export const BREAKDOWN_ROW_LIMIT = 100
