/** The first instant of `date`'s month, in UTC. Never the local zone: a
 * month boundary that moved with a deployment's timezone would put the same
 * row in different months on different instances. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

/** Month arithmetic on the truncated month, so a caller passing the 31st
 * cannot land two months out — Date.UTC(2026, 1, 31) is 3 March. */
export function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
}
