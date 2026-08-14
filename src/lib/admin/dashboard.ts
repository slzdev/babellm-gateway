import 'server-only'
import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users as usersTable } from '@/lib/db/schema'
import { listApiKeys } from '@/lib/admin/keys'
import { grainFor, type Grain } from '@/lib/stats/buckets'
import {
  EMPTY_TOTALS, loadBreakdown, loadRollupModels, loadSeries, loadTotals,
} from '@/lib/stats/query'
import { readRollupState } from '@/lib/stats/state'
import { resolveRequestLogStore } from '@/lib/logs'
import type {
  BreakdownDimension, BreakdownRow, UsageFilter, UsagePoint, UsageTotals,
} from '@/lib/stats/types'
import { DASHBOARD_RANGES, DEFAULT_DASHBOARD_RANGE } from './dashboard-params'

export { DASHBOARD_RANGES, DEFAULT_DASHBOARD_RANGE }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000

export interface DashboardSearchParams {
  range?: string
  key?: string
  user?: string
  model?: string
  from?: string
  to?: string
}

export interface ParsedDashboard {
  filter: UsageFilter
  /** The equal-length window before `filter`, or null when the range has no
   * meaningful "before" (all time). */
  previous: UsageFilter | null
  range: string
  grain: Grain
}

/** uuids reach a uuid column comparison; a malformed one is an unhandled
 * Postgres error rather than an empty result, so it is dropped here. */
function uuid(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined
}

/** A `YYYY-MM-DD` from a date input, read as UTC midnight. */
function day(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Turns URL search params into a filter.
 *
 * Every unrecognized value degrades to the default rather than throwing: a
 * hand-edited URL should show the default view, not an error page.
 */
export function parseDashboardFilter(
  params: DashboardSearchParams,
  now: Date = new Date(),
): ParsedDashboard {
  const range = params.range && params.range in DASHBOARD_RANGES
    ? params.range
    : DEFAULT_DASHBOARD_RANGE

  const custom = { from: day(params.from), to: day(params.to) }
  // The end day is inclusive: picking 1st to 3rd means through the end of the
  // 3rd, not up to its first instant.
  const customTo = custom.to ? new Date(custom.to.getTime() + DAY_MS) : null

  const window = DASHBOARD_RANGES[range]
  const useCustom = custom.from !== null && customTo !== null && custom.from < customTo

  const from = useCustom
    ? custom.from!
    : window === null ? new Date(0) : new Date(now.getTime() - window)
  const to = useCustom ? customTo! : now

  const dimensions = {
    ...(uuid(params.key) ? { apiKeyId: uuid(params.key) } : {}),
    ...(uuid(params.user) ? { userId: uuid(params.user) } : {}),
    ...(params.model?.trim() && params.model !== 'all' ? { model: params.model.trim() } : {}),
  }

  const filter: UsageFilter = { from, to, ...dimensions }

  // No "before all time", so no delta to show against it.
  const span = to.getTime() - from.getTime()
  const previous = !useCustom && window === null
    ? null
    : { from: new Date(from.getTime() - span), to: from, ...dimensions }

  return { filter, previous, range, grain: grainFor(from, to) }
}

export interface DashboardView {
  totals: UsageTotals
  previous: UsageTotals | null
  series: UsagePoint[]
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>
  models: string[]
  keys: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string }>
  /** The oldest hour the backfill has aggregated, when history is still
   * incomplete. Null once it has reached the oldest surviving log. */
  backfilledTo: Date | null
  /** The configured log store. Rollups are built from the Postgres store's
   * table, so anything else means this page has nothing to aggregate — an
   * explicit state, mirroring the "cannot be read back" panel on /logs. Only
   * `postgres` ships, but the registry exists for forks to add drivers. */
  storeName: string
  /** True when the read failed outright. Distinct from "no data": the page
   * renders its own banner rather than the generic Next error screen. */
  error: boolean
}

const NO_BREAKDOWNS = { model: [], key: [], user: [], provider: [] }

export async function loadDashboard(parsed: ParsedDashboard): Promise<DashboardView> {
  try {
    const [
      totals, previous, series, model, key, user, provider, models, keys, users, backfilledTo,
      store,
    ] = await Promise.all([
      loadTotals(parsed.filter),
      parsed.previous ? loadTotals(parsed.previous) : Promise.resolve(null),
      loadSeries(parsed.filter, parsed.grain),
      loadBreakdown(parsed.filter, 'model'),
      loadBreakdown(parsed.filter, 'key'),
      loadBreakdown(parsed.filter, 'user'),
      loadBreakdown(parsed.filter, 'provider'),
      loadRollupModels(),
      listApiKeys(),
      db.select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable).orderBy(asc(usersTable.name)),
      pendingBackfill(),
      resolveRequestLogStore(),
    ])

    return {
      totals, previous, series,
      breakdowns: { model, key, user, provider },
      models,
      keys: keys.map((k) => ({ id: k.id, name: k.name })),
      users,
      backfilledTo,
      storeName: store.store.name,
      error: false,
    }
  } catch (err) {
    console.error('[gateway] could not load the usage dashboard', err)
    return {
      totals: EMPTY_TOTALS, previous: null, series: [],
      breakdowns: NO_BREAKDOWNS, models: [], keys: [], users: [],
      backfilledTo: null, storeName: 'unknown', error: true,
    }
  }
}

/**
 * The earliest aggregated hour while history is still being filled in, so a
 * total that is not yet complete never reads as one that is.
 *
 * Both halves come from the rollup job's own state row. Measuring the oldest
 * log here instead would put a `request_logs` query on every page load, and
 * this page reading only `usage_rollups` is the entire point of the feature —
 * the state row already carries the value the job measured. A stale one at
 * worst leaves the banner up for one extra tick after the backfill finishes.
 */
async function pendingBackfill(): Promise<Date | null> {
  const state = await readRollupState(new Date())
  if (!state.backfilledTo || !state.oldestLog) return null
  return state.backfilledTo > state.oldestLog ? state.backfilledTo : null
}
