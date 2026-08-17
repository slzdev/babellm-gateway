/** Namespaced beside `babellm:usage` so a shared Redis stays legible. */
export const PREFIX = 'babellm:health'

/** Exists ⇒ the breaker is open. Its TTL is the cooldown, which makes Redis
 *  itself the clock every instance agrees on. */
export const openKey = (targetId: string) => `${PREFIX}:open:${targetId}`

/** Consecutive failures. */
export const failKey = (targetId: string) => `${PREFIX}:fail:${targetId}`

/** Display-only: openedAt and lastError, written on transition only so the
 *  request path never touches it. */
export const metaKey = (targetId: string) => `${PREFIX}:meta:${targetId}`

/** Floor, so a short cooldown still lets failures accumulate across a gap
 *  between requests rather than decaying between two of them. */
export const MIN_FAIL_TTL_SECONDS = 60

/**
 * One rule doing two jobs.
 *
 * It decays stale failures on a target that has gone quiet; and because it is
 * always strictly greater than the cooldown, the counter is still sitting at
 * the threshold when the open marker expires. That is what makes half-open
 * free: the target rejoins the chain, and one further failure increments past
 * the threshold and re-opens it immediately.
 */
export function failTtlSeconds(cooldownSeconds: number): number {
  return Math.max(MIN_FAIL_TTL_SECONDS, cooldownSeconds * 2)
}

export const MAX_ERROR_LENGTH = 300

/** An upstream can return a very long message; the hash is display-only and
 *  a badge tooltip cannot show more than this anyway. */
export function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message
}
