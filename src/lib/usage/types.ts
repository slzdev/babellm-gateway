/** One counter mutation. `by: 0` is a read. */
export interface CounterOp {
  key: string
  /** Integer counters use INCRBY; money uses INCRBYFLOAT. */
  kind: 'int' | 'float'
  by: number
  /** Seconds. Applied on write; omitted leaves any existing expiry alone. */
  ttlSeconds?: number
}

export interface StoreStatus {
  healthy: boolean
  error: string | null
}

export interface UsageStore {
  readonly name: string
  /**
   * Applies every op in one round trip and returns each counter's value
   * *after* this op's contribution, in the order the ops were given.
   *
   * The return value is the atomicity: two concurrent callers incrementing
   * the same counter get different numbers back, so each can decide for
   * itself whether it was the one that crossed a line. That is why this
   * needs no server-side scripting.
   */
  apply(ops: CounterOp[]): Promise<number[]>
  /** Delete counters outright. The caller names them — a driver has no idea
   * what an API key is. */
  del(keys: string[]): Promise<void>
  /**
   * Last known state, for the Governance tab. Never blocks on or waits for a
   * connection — the redis driver does dial immediately on construction (see
   * `redis.ts`), but this reads whatever state that connection is already in
   * rather than initiating or awaiting one of its own.
   */
  status(): StoreStatus
  close?(): Promise<void>
}
