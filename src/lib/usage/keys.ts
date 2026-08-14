/**
 * Counter names and window arithmetic.
 *
 * Every function here is pure and takes `now` explicitly, so the awkward
 * moments — a bucket boundary, the first of the month — are tested by passing
 * a number rather than by mocking a clock.
 */

/** Namespaced so a shared Redis stays legible and `del` is a bounded list. */
export const PREFIX = 'babellm:usage'

export const WINDOW_MS = 60_000
/** Two windows: the current bucket and the previous one the estimate reads. */
export const WINDOW_TTL_SECONDS = 120
/** Long enough that last month is still readable during this one, short
 * enough that months do not accumulate. Refreshed on every write. */
export const MONTH_TTL_SECONDS = 70 * 24 * 60 * 60

export function bucketOf(now: number): number {
  return Math.floor(now / WINDOW_MS)
}

export function monthOf(now: number): string {
  const date = new Date(now)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}`
}

export function windowKey(kind: 'rpm' | 'tpm', keyId: string, bucket: number): string {
  return `${PREFIX}:${kind}:${keyId}:${bucket}`
}

export function monthlySpendKey(keyId: string, now: number): string {
  return `${PREFIX}:spend:${keyId}:${monthOf(now)}`
}

/** The one counter with no expiry, which is why deleting a key must name it. */
export function totalSpendKey(keyId: string): string {
  return `${PREFIX}:spend:${keyId}:total`
}

/**
 * Every counter a key could still own right now.
 *
 * Older minute buckets and earlier months are already expiring on their own,
 * so this stays a fixed six names — no SCAN, and no unbounded delete.
 */
export function allKeysFor(keyId: string, now: number): string[] {
  const bucket = bucketOf(now)
  return [
    windowKey('rpm', keyId, bucket),
    windowKey('rpm', keyId, bucket - 1),
    windowKey('tpm', keyId, bucket),
    windowKey('tpm', keyId, bucket - 1),
    monthlySpendKey(keyId, now),
    totalSpendKey(keyId),
  ]
}

/**
 * The sliding window estimate: the current bucket in full, plus however much
 * of the previous one has not yet rolled off.
 *
 * A fixed window would let a key spend its whole allowance in the last second
 * of one minute and again in the first second of the next. This costs one
 * extra read in a batch that was already being sent.
 */
export function estimate(previous: number, current: number, now: number): number {
  const elapsed = (now % WINDOW_MS) / WINDOW_MS
  return previous * (1 - elapsed) + current
}

/** Seconds until the offending minute has certainly rolled off. A sliding
 * window relieves gradually, so this is an honest floor rather than an exact
 * answer. Never 0 — that would read as "retry now". */
export function secondsToWindowEnd(now: number): number {
  return Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000)
}

export function secondsToMonthEnd(now: number): number {
  const date = new Date(now)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return Math.ceil((next - now) / 1000)
}
