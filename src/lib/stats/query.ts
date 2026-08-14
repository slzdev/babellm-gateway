import 'server-only'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import type { Grain } from './buckets'
import { BREAKDOWN_ROW_LIMIT } from './types'
import type {
  BreakdownDimension, BreakdownRow, UsageFilter, UsagePoint, UsageTotals,
} from './types'

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0, errorRequests: 0, unpricedRequests: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  costUsd: '0', avgLatencyMs: null, maxLatencyMs: null, avgTtftMs: null,
}

function conditions(filter: UsageFilter) {
  const where = [gte(usageRollups.bucket, filter.from), lt(usageRollups.bucket, filter.to)]
  if (filter.apiKeyId) where.push(eq(usageRollups.apiKeyId, filter.apiKeyId))
  if (filter.userId) where.push(eq(usageRollups.userId, filter.userId))
  if (filter.model) where.push(eq(usageRollups.model, filter.model))
  return and(...where)
}

const int = (value: unknown): number => Number(value ?? 0)
/** Null rather than 0 when nothing was measured: a 0 ms average is the same
 * family of lie as an unpriced request costing $0. */
const avg = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

// A runtime lookup, not string interpolation: `sql.raw(`'${grain}'`)` would
// let a single `'` in `grain` escape the literal and inject arbitrary SQL.
// Nothing reaches this with an unchecked string today — Grain is produced
// only by grainFor() — but the type is erased at runtime, and the plausible
// next caller is a `?grain=` query param read as `params.grain as Grain`.
// Restricting the lookup to these three fixed fragments is what actually
// makes that safe, not the `Grain` type annotation. Each grain reuses the
// same `sql.raw` object across select/groupBy/orderBy in loadSeries, so all
// three occurrences stay identical text for Postgres's GROUP BY match.
const GRAIN_LITERAL: Record<Grain, ReturnType<typeof sql.raw>> = {
  hour: sql.raw("'hour'"), day: sql.raw("'day'"), month: sql.raw("'month'"),
}

function grainLiteral(grain: Grain) {
  const literal = GRAIN_LITERAL[grain]
  if (!literal) throw new Error(`unknown grain: ${grain}`)
  return literal
}

export async function loadTotals(filter: UsageFilter): Promise<UsageTotals> {
  const [row] = await db
    .select({
      requests: sql<string>`coalesce(sum(${usageRollups.requests}), 0)`,
      errorRequests: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} <> 'success'), 0)`,
      unpricedRequests: sql<string>`coalesce(sum(${usageRollups.unpricedRequests}), 0)`,
      promptTokens: sql<string>`coalesce(sum(${usageRollups.promptTokens}), 0)`,
      completionTokens: sql<string>`coalesce(sum(${usageRollups.completionTokens}), 0)`,
      cachedTokens: sql<string>`coalesce(sum(${usageRollups.cachedTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`,
      avgLatencyMs: sql<string | null>`sum(${usageRollups.latencySumMs})::numeric / nullif(sum(${usageRollups.latencyCount}), 0)`,
      maxLatencyMs: sql<string | null>`max(${usageRollups.latencyMaxMs})`,
      avgTtftMs: sql<string | null>`sum(${usageRollups.ttftSumMs})::numeric / nullif(sum(${usageRollups.ttftCount}), 0)`,
    })
    .from(usageRollups)
    .where(conditions(filter))

  if (!row) return EMPTY_TOTALS

  return {
    requests: int(row.requests),
    errorRequests: int(row.errorRequests),
    unpricedRequests: int(row.unpricedRequests),
    promptTokens: int(row.promptTokens),
    completionTokens: int(row.completionTokens),
    cachedTokens: int(row.cachedTokens),
    costUsd: String(row.costUsd ?? '0'),
    avgLatencyMs: avg(row.avgLatencyMs),
    maxLatencyMs: avg(row.maxLatencyMs),
    avgTtftMs: avg(row.avgTtftMs),
  }
}

export async function loadSeries(filter: UsageFilter, grain: Grain): Promise<UsagePoint[]> {
  // date_trunc with an explicit zone, for the same reason bucketExpr uses
  // one: without it the grouping would depend on the session's TimeZone.
  //
  // `grain` is inlined via the GRAIN_LITERAL lookup rather than parameterized:
  // this fragment is reused in select, groupBy, and orderBy, and drizzle
  // assigns each occurrence its own placeholder ($1, $4, $5, ...). Postgres
  // matches GROUP BY expressions syntactically, before parameters are bound,
  // so `date_trunc($1, ...)` and `date_trunc($4, ...)` don't count as the same
  // expression even though both hold 'hour' at run time — "column must
  // appear in the GROUP BY clause" results. Reusing the same sql.raw literal
  // object for a given grain makes all three occurrences identical text,
  // which Postgres does match.
  //
  // Typed <string>, not <Date>: drizzle's node-postgres driver overrides
  // getTypeParser to return TIMESTAMPTZ (OID 1184) as-is rather than parsing
  // it — a schema column recovers a Date only via PgTimestamp's own
  // mapFromDriverValue, and a raw sql fragment like this one has no column
  // mapper to apply that conversion. So this comes back as the driver's text
  // rendering of timestamptz ("2026-08-14 13:00:00+00"), parsed to a Date
  // below, in the row mapper.
  const bucket = sql<string>`date_trunc(${grainLiteral(grain)}, ${usageRollups.bucket}, 'UTC')`

  const rows = await db
    .select({
      bucket,
      success: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'success'), 0)`,
      clientError: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'client_error'), 0)`,
      serverError: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} = 'server_error'), 0)`,
      costUsd: sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`,
    })
    .from(usageRollups)
    .where(conditions(filter))
    .groupBy(bucket)
    .orderBy(bucket)

  return rows.map((r) => ({
    bucket: new Date(r.bucket),
    success: int(r.success),
    clientError: int(r.clientError),
    serverError: int(r.serverError),
    costUsd: String(r.costUsd ?? '0'),
  }))
}

const DIMENSIONS = {
  model: { id: usageRollups.model, label: usageRollups.model },
  key: { id: usageRollups.apiKeyId, label: usageRollups.keyName },
  user: { id: usageRollups.userId, label: usageRollups.userName },
  provider: { id: usageRollups.provider, label: usageRollups.provider },
} as const

export async function loadBreakdown(
  filter: UsageFilter,
  dimension: BreakdownDimension,
): Promise<BreakdownRow[]> {
  const { id, label } = DIMENSIONS[dimension]
  const cost = sql<string>`coalesce(sum(${usageRollups.costUsd}), 0)`

  const rows = await db
    .select({
      id: sql<string | null>`${id}::text`,
      // max(), not a group column: the label can vary within one id when a
      // key or user was renamed mid-range, and grouping by it would split one
      // entity into two rows.
      label: sql<string | null>`max(${label})`,
      requests: sql<string>`coalesce(sum(${usageRollups.requests}), 0)`,
      errorRequests: sql<string>`coalesce(sum(${usageRollups.requests}) FILTER (WHERE ${usageRollups.statusClass} <> 'success'), 0)`,
      tokens: sql<string>`coalesce(sum(${usageRollups.promptTokens} + ${usageRollups.completionTokens}), 0)`,
      costUsd: cost,
    })
    .from(usageRollups)
    .where(conditions(filter))
    .groupBy(id)
    .orderBy(sql`${cost} DESC`)
    .limit(BREAKDOWN_ROW_LIMIT)

  return rows.map((r) => ({
    id: r.id,
    // A row whose dimension is null is real usage that must still be shown —
    // dropping it would make the breakdown disagree with the totals.
    label: r.label ?? 'unknown',
    requests: int(r.requests),
    errorRequests: int(r.errorRequests),
    tokens: int(r.tokens),
    costUsd: String(r.costUsd ?? '0'),
  }))
}

/**
 * The models the filter bar can offer.
 *
 * From the rollup rather than from virtual_models, which is what /logs uses:
 * that misses direct `provider/model` addresses entirely. Reading it here is
 * cheap against a small table, and it can only ever offer values that have
 * data behind them.
 */
export async function loadRollupModels(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: usageRollups.model })
    .from(usageRollups)
    .orderBy(usageRollups.model)

  return rows.map((r) => r.model).filter((m): m is string => m !== null)
}
