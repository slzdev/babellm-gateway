/**
 * Pure filter-URL helpers shared between the server-side parser
 * (`parseDashboardFilter` in `./dashboard`) and the client-side filter bar.
 *
 * Must stay free of the `server-only` boundary, for the same reason
 * `log-filter-params.ts` states: the filter bar is a Client Component, so
 * anything it imports lands in the browser bundle, and importing `./dashboard`
 * there would drag db and pg in with it and fail the build.
 */

export const DEFAULT_DASHBOARD_RANGE = '7d'

/** Milliseconds per preset. `null` means no lower bound at all. */
export const DASHBOARD_RANGES: Record<string, number | null> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  all: null,
}

const NEUTRAL_VALUES: Record<string, string> = {
  range: DEFAULT_DASHBOARD_RANGE,
  key: 'all',
  user: 'all',
  model: 'all',
}

/**
 * Applies one filter change: deletes the param when the value is that
 * filter's neutral one, sets it otherwise.
 *
 * Choosing a preset also clears `from`/`to`. A custom range wins over a
 * preset in `parseDashboardFilter`, so leaving the dates behind would make
 * the preset the user just clicked appear to do nothing.
 */
export function nextDashboardParams(
  current: URLSearchParams,
  name: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  if (!value || value === NEUTRAL_VALUES[name]) next.delete(name)
  else next.set(name, value)
  if (name === 'range') {
    next.delete('from')
    next.delete('to')
  }
  return next
}
