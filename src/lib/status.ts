export interface Status {
  status: 'ok'
  /** Seconds this process has been running. */
  uptime: number
}

/**
 * A liveness answer: this process is running and serving requests.
 *
 * Deliberately free of dependency checks. Postgres and the counter store are
 * shared by every instance, so failing this endpoint when one of them blips
 * would pull the whole fleet out of the load balancer at once — turning a
 * degraded gateway into an unreachable one. A dependency outage belongs in
 * monitoring and in the dashboard's own status readouts, not in the probe
 * that decides whether to keep routing traffic here.
 */
export function buildStatus(): Status {
  return { status: 'ok', uptime: Math.round(process.uptime()) }
}
