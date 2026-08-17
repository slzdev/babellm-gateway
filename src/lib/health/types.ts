/** How a target's breaker reads. `half_open` is derived, never stored. */
export type BreakerState = 'closed' | 'half_open' | 'open'

export interface BreakerConfig {
  /** Consecutive failures required to open. 0 disables the breaker. */
  threshold: number
  cooldownSeconds: number
}

/**
 * Facts read out of the store.
 *
 * Deliberately free of any interpretation that would require the store to
 * know a target's configured threshold — that is configuration, and a driver
 * has no idea what a route target is. `breakerState()` does the interpreting.
 */
export interface TargetHealth {
  open: boolean
  /** Seconds until the open marker expires. null unless open. */
  reopensIn: number | null
  consecutiveFailures: number
  openedAt: number | null
  lastError: string | null
}

/** A target with no keys at all. Absence of state is health, not unknown. */
export const CLOSED: TargetHealth = {
  open: false,
  reopensIn: null,
  consecutiveFailures: 0,
  openedAt: null,
  lastError: null,
}

export interface StoreStatus {
  healthy: boolean
  error: string | null
}

export interface HealthStore {
  readonly name: string
  /**
   * The request path's only read: which of these targets are currently open.
   * One round trip, and no interpretation — half-open is closed for ordering.
   */
  openTargets(targetIds: string[]): Promise<Set<string>>
  /** The admin page's read. Targets with no state are absent from the map. */
  details(targetIds: string[]): Promise<Map<string, TargetHealth>>
  /** Records a failed attempt, opening the breaker when the count reaches
   *  `config.threshold`. A threshold of 0 makes this a no-op. */
  fail(targetId: string, config: BreakerConfig, error: string): Promise<void>
  succeed(targetId: string): Promise<void>
  /** Manual reset from the dashboard: forget everything about this target. */
  reset(targetId: string): Promise<void>
  status(): StoreStatus
  close?(): Promise<void>
}
