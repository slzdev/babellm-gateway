/**
 * How long one upstream attempt may take.
 *
 * Its own module rather than a constant in execute.ts, for the reason
 * api-flavors.ts gives: the provider dialogs are client components and need
 * the default to render as a placeholder, and execute.ts is server-only.
 *
 * 30 seconds, not the two minutes this gateway shipped with. A ceiling that
 * high delays every failover behind a wedged provider, and the providers that
 * genuinely need longer — anything serving a long reasoning request, which is
 * the same set that needs force_upstream_stream — are better served by an
 * explicit, visible number than by a hidden default nobody can find.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** One hour. Past this a request has outlived any client that would still be
 *  waiting for it, and the value is far more likely to be a typo. */
export const MAX_TIMEOUT_MS = 3_600_000

/**
 * Reads the provider form's timeout field.
 *
 * Blank returns null, which the action turns into deleting the config key —
 * so "blank" keeps meaning "the default" rather than pinning today's default
 * forever. Anything unparseable throws, because a silently ignored timeout is
 * exactly the failure an operator would not notice until a request they
 * expected to survive ten minutes died at thirty seconds.
 */
export function parseTimeoutMs(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  // Deliberately stricter than Number(): "1e5" and "1.5" both parse to a
  // finite number, and neither is a millisecond count anyone typed on
  // purpose. A leading "-" is still accepted here so a negative value falls
  // through to the bounds check below and reports as out-of-range rather
  // than as a malformed number.
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error('The request timeout must be a whole number of milliseconds.')
  }

  const value = Number(trimmed)
  if (value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`The request timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`)
  }
  return value
}
