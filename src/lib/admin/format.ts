/** Display helpers for the dashboard. No `server-only`: the tiles render on
 * the server but the chart tooltip is a Client Component. */

/**
 * Costs arrive as numeric(18,9) strings.
 *
 * Four decimal places for anything a person would call money, and up to nine
 * for a total small enough that four would round it to $0.0000 — the same
 * refusal to show a lying zero that request_logs' scale-9 columns exist for.
 */
export function formatCost(value: string): string {
  const amount = Number(value)
  if (amount === 0) return '$0'
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`
  // Stripping trailing zeros can leave a bare "0." when every one of the nine
  // decimals rounds to zero (an amount under half a tenth-of-a-nano-dollar) —
  // strip a dangling decimal point too, rather than hand back malformed text.
  return `$${amount.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')}`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Change against the previous period, or null when there is nothing to
 * compare with.
 *
 * Growth from zero is reported as "new" rather than as a percentage: the
 * arithmetic is Infinity, and no reader is served by seeing it.
 */
export function formatDelta(current: number, previous: number | null): string | null {
  if (previous === null) return null
  if (previous === 0) return current === 0 ? null : 'new'

  const change = Math.round(((current - previous) / previous) * 100)
  return change > 0 ? `+${change}%` : `${change}%`
}

/**
 * The movement between two rates, in percentage points.
 *
 * Not formatDelta: a percent change *of* a percentage reads as an alarm for
 * something that is not one. An error rate going from 0.14% to 0.15% of
 * requests is "+7%" that way — and "+100%" if the rates are rounded before
 * the division, which is how this started. Points say what actually moved.
 *
 * Quoted at the same one decimal the rate beside it is quoted at, so the
 * delta can never claim a movement the displayed value does not show — and
 * when nothing moved at that precision it says so rather than printing a
 * signed zero.
 *
 * Takes rates as fractions (0.014 for 1.4%), the form `errors / requests`
 * already has.
 */
export function formatPointsDelta(current: number, previous: number | null): string | null {
  if (previous === null) return null

  const points = (current - previous) * 100
  if (Math.abs(points) < 0.05) return 'no change'
  return `${points > 0 ? '+' : '-'}${Math.abs(points).toFixed(1)} pp`
}
