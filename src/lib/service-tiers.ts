/**
 * The tiers a route target can pin `service_tier` to.
 *
 * Its own module rather than a constant in the schema or the admin layer,
 * because the target dialogs are client components: they need this list to
 * render the selector, and both of those modules are server-only. The schema's
 * pgEnum is built from this array, so the column and the selector cannot drift.
 *
 * Deliberately a union of what several vendors offer rather than any one
 * provider's enum — the gateway passes the value through, so which names a
 * given upstream honours is the operator's business, not this list's.
 */
export const SERVICE_TIERS = [
  'auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast',
] as const

export type ServiceTier = (typeof SERVICE_TIERS)[number]
