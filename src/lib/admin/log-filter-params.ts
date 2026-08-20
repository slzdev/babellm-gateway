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

/** Rows per page the user may choose between. Anything else in the URL
 * degrades to the default, the same as an unrecognized range. */
export const LOG_PAGE_SIZES = [5, 10, 25, 50, 100] as const

export const DEFAULT_LOG_PAGE_SIZE = 50

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
  size: String(DEFAULT_LOG_PAGE_SIZE),
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

/**
 * Adds one `key=value` token to the tag filter, replacing any existing token
 * for the same key.
 *
 * `nextFilterParams` cannot serve here: it calls `URLSearchParams.set`, which
 * replaces every value of a name, and `tag` is the first multi-valued filter.
 * `NEUTRAL_VALUES` gains no entry for the same reason — "no tag filter" is
 * expressed by having no `tag` params, not by a sentinel value.
 *
 * A tag key is a dimension and the filter is conjunctive (see `tagFilter` in
 * `./logs`), so two values for the same key can never both match — the query
 * that runs is first-wins. Replacing rather than appending keeps the chips
 * the filter bar renders equal to the filter that actually ran.
 *
 * Cursors are cleared exactly as `nextFilterParams` clears them: a filter
 * change makes the old keyset position meaningless whether the filter holds
 * one value or many.
 */
export function addTagParam(current: URLSearchParams, token: string): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  if (token) {
    const key = token.slice(0, token.indexOf('='))
    const kept = next.getAll('tag').filter((value) => !value.startsWith(`${key}=`))
    next.delete('tag')
    for (const value of kept) next.append('tag', value)
    next.append('tag', token)
  }
  next.delete('after')
  next.delete('before')
  return next
}

/** Removes one `key=value` token from the tag filter, leaving the others. */
export function removeTagParam(current: URLSearchParams, token: string): URLSearchParams {
  const next = new URLSearchParams(current.toString())
  const kept = next.getAll('tag').filter((value) => value !== token)
  next.delete('tag')
  for (const value of kept) next.append('tag', value)
  next.delete('after')
  next.delete('before')
  return next
}
