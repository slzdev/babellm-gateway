/**
 * Pure filter-URL helpers shared between the server-side filter parser
 * (`parseLogFilter` in `./logs`) and the client-side filter bar
 * (`app/(admin)/logs/log-filters.tsx`).
 *
 * This module must stay free of the `server-only` boundary. The filter bar
 * is a Client Component, so anything it imports is included in the browser
 * bundle — importing `./logs` there would drag its whole server-only chain
 * (db, pg, the postgres log driver) into that bundle and fail the build.
 * `./logs` imports `DEFAULT_RANGE` back from here instead of the reverse.
 */

export const DEFAULT_RANGE = '24h'

/**
 * Each filter's "neutral" value — the one whose selection means the same
 * thing as the param being absent from the URL, and so should delete the
 * param rather than write it.
 *
 * `range` is the odd one out: an absent range means the 24h default, not
 * "all time". A literal `value === 'all'` check would delete `range=all`
 * along with every other filter's "any" option, so `parseLogFilter` would
 * fall back to the default and silently narrow the query to 24h. Keying the
 * neutral value per filter, instead of hardcoding the string `'all'`, is
 * what keeps range's neutral value distinct from every other filter's.
 */
const NEUTRAL_VALUES: Record<string, string> = {
  range: DEFAULT_RANGE,
  key: 'all',
  model: 'all',
  status: 'all',
}

/**
 * Applies one filter change to a URLSearchParams: deletes the param when the
 * new value is that filter's neutral value (or empty), sets it otherwise,
 * and always clears both cursors — a filter change makes the old keyset
 * position meaningless.
 */
export function nextFilterParams(
  current: URLSearchParams,
  name: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  if (!value || value === NEUTRAL_VALUES[name]) next.delete(name)
  else next.set(name, value)
  next.delete('after')
  next.delete('before')
  return next
}
