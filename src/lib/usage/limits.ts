import 'server-only'
import { GatewayError } from '@/lib/gateway/errors'
import {
  MONTH_TTL_SECONDS, WINDOW_TTL_SECONDS, allKeysFor, bucketOf, estimate,
  monthlySpendKey, secondsToMonthEnd, secondsToWindowEnd, totalSpendKey, windowKey,
} from './keys'
import { getUsageStore } from './registry'
import type { CounterOp } from './types'

/** The subset of an api_keys row this module needs. A structural type rather
 * than ApiKeyRow so the admin list can pass its own projection. */
export interface KeyLimits {
  id: string
  rpmLimit: number | null
  tpmLimit: number | null
  budgetMonthlyUsd: string | null
  budgetTotalUsd: string | null
}

/** What a key has actually used. `null` means "not counted" — the key has no
 * limit of that kind — which must not render as 0. */
export interface UsageReading {
  rpm: number | null
  tpm: number | null
  monthUsd: number | null
  totalUsd: number | null
}

export interface LimitSnapshot {
  rpm: { limit: number; remaining: number; resetSeconds: number } | null
  tpm: { limit: number; remaining: number; resetSeconds: number } | null
}

/**
 * A request rejected by this module, and only by this module.
 *
 * Its own class rather than a status check: an upstream provider's 429
 * reaching the handler's catch is a completely different event that must
 * still be logged, and `status === 429` cannot tell them apart.
 */
export class LimitExceededError extends GatewayError {
  readonly headers: Record<string, string>

  constructor(init: {
    code: 'rate_limit_exceeded' | 'insufficient_quota'
    message: string
    headers: Record<string, string>
  }) {
    super({ status: 429, type: 'rate_limit_error', code: init.code, message: init.message })
    this.name = 'LimitExceededError'
    this.headers = init.headers
  }
}

export function hasLimits(key: KeyLimits): boolean {
  return key.rpmLimit !== null
    || key.tpmLimit !== null
    || key.budgetMonthlyUsd !== null
    || key.budgetTotalUsd !== null
}

/** One line per outage rather than one per request. A Redis failure under
 * load must not cost more in stderr than the outage costs in service. */
const FAILURE_LOG_INTERVAL_MS = 10_000
let lastFailureLoggedAt = 0

function reportFailure(err: unknown): void {
  const now = Date.now()
  if (now - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLoggedAt = now
  console.error('[gateway] usage counter store failed; limits not enforced', err)
}

/** The names `checkLimits` reads back out of `ops` by index. A literal union
 * rather than `string`: a typo here would silently fall back to `value()`'s
 * "not pushed" case (0), which for a budget read means "nothing spent" and
 * the limit stops being enforced with no error anywhere. As a union, that
 * typo is a compile error instead. */
type OpName = 'rpmCurrent' | 'rpmPrevious' | 'tpmCurrent' | 'tpmPrevious' | 'month' | 'total'

/**
 * Decides whether this request may proceed, and counts it if it may.
 *
 * Returns the snapshot the response headers are built from, or `null` when no
 * decision was made — the key has no limits, or the store was unreachable.
 * Throws `LimitExceededError` when a limit is breached.
 */
export async function checkLimits(
  key: KeyLimits,
  now: number = Date.now(),
): Promise<LimitSnapshot | null> {
  if (!hasLimits(key)) return null

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []
  const at: Partial<Record<OpName, number>> = {}
  const push = (name: OpName, op: CounterOp) => {
    at[name] = ops.length
    ops.push(op)
  }

  // rpm is the only counter incremented here: this request is the one being
  // decided, and INCRBY's return value is what makes that decision safe
  // under concurrency.
  if (key.rpmLimit !== null) {
    push('rpmCurrent', {
      key: windowKey('rpm', key.id, bucket), kind: 'int', by: 1,
      ttlSeconds: WINDOW_TTL_SECONDS,
    })
    push('rpmPrevious', { key: windowKey('rpm', key.id, bucket - 1), kind: 'int', by: 0 })
  }
  // tpm is read, never incremented here: this request's token count does not
  // exist yet.
  if (key.tpmLimit !== null) {
    push('tpmCurrent', { key: windowKey('tpm', key.id, bucket), kind: 'int', by: 0 })
    push('tpmPrevious', { key: windowKey('tpm', key.id, bucket - 1), kind: 'int', by: 0 })
  }
  if (key.budgetMonthlyUsd !== null) {
    push('month', { key: monthlySpendKey(key.id, now), kind: 'float', by: 0 })
  }
  if (key.budgetTotalUsd !== null) {
    push('total', { key: totalSpendKey(key.id), kind: 'float', by: 0 })
  }

  let values: number[]
  try {
    values = await getUsageStore().apply(ops)
  } catch (err) {
    // Fail open. Availability beats enforcement: a store blip must not take
    // the gateway down with it.
    reportFailure(err)
    return null
  }

  const value = (name: OpName) => (at[name] === undefined ? 0 : values[at[name]])

  const rpm = key.rpmLimit === null
    ? null
    : estimate(value('rpmPrevious'), value('rpmCurrent'), now)
  const tpm = key.tpmLimit === null
    ? null
    : estimate(value('tpmPrevious'), value('tpmCurrent'), now)

  const snapshot: LimitSnapshot = {
    rpm: key.rpmLimit === null ? null : {
      limit: key.rpmLimit,
      remaining: Math.max(0, Math.floor(key.rpmLimit - (rpm ?? 0))),
      resetSeconds: secondsToWindowEnd(now),
    },
    tpm: key.tpmLimit === null ? null : {
      limit: key.tpmLimit,
      remaining: Math.max(0, Math.floor(key.tpmLimit - (tpm ?? 0))),
      resetSeconds: secondsToWindowEnd(now),
    },
  }

  /** Undo this request's rpm tick. A client that ignores its 429s must not be
   * able to extend its own lockout. Fire and forget on a path that is already
   * failing; if the process dies first the window reads one high until it
   * expires, which is the whole price of not using server-side scripting. */
  const compensate = () => {
    if (key.rpmLimit === null) return
    // ttlSeconds is set here too, matching the increment this undoes. A
    // bucket's identity is its key *name* — the minute number baked into
    // `windowKey` — not its TTL, so refreshing the expiry cannot extend the
    // window; it only extends how long a dead bucket stays around. Omitting
    // it would be a real leak: if the window has already expired by the time
    // this runs, a bare INCRBY recreates the key from nothing, with no TTL
    // at all, in both drivers — a permanent key that decays to -1 in Redis
    // and never leaves the map in memory.
    void getUsageStore()
      .apply([{
        key: windowKey('rpm', key.id, bucket), kind: 'int', by: -1,
        ttlSeconds: WINDOW_TTL_SECONDS,
      }])
      .catch(reportFailure)
  }

  // Precedence: rpm, tpm, monthly budget, total budget. A key that is both
  // throttled and out of budget is told it is throttled, because that is the
  // condition that will clear on its own.
  //
  // `>` for rpm because its counter already includes this request — the
  // question is whether this request fits. `>=` for everything else because
  // their counters cannot include it — the question is whether there is any
  // room left at all.
  if (rpm !== null && key.rpmLimit !== null && rpm > key.rpmLimit) {
    compensate()
    throw new LimitExceededError({
      code: 'rate_limit_exceeded',
      message: `Rate limit reached for this API key: ${key.rpmLimit} requests per minute.`,
      // `remaining` is already 0 here — it is computed as
      // max(0, limit - estimate), and we only get here when estimate > limit.
      headers: {
        'retry-after': String(secondsToWindowEnd(now)),
        ...rateLimitHeaders(snapshot),
      },
    })
  }

  if (tpm !== null && key.tpmLimit !== null && tpm >= key.tpmLimit) {
    compensate()
    throw new LimitExceededError({
      code: 'rate_limit_exceeded',
      message: `Rate limit reached for this API key: ${key.tpmLimit} tokens per minute.`,
      headers: {
        'retry-after': String(secondsToWindowEnd(now)),
        ...rateLimitHeaders(snapshot),
      },
    })
  }

  if (key.budgetMonthlyUsd !== null && value('month') >= Number(key.budgetMonthlyUsd)) {
    compensate()
    throw new LimitExceededError({
      code: 'insufficient_quota',
      message: `This API key has reached its monthly budget of $${key.budgetMonthlyUsd}.`,
      headers: { 'retry-after': String(secondsToMonthEnd(now)) },
    })
  }

  if (key.budgetTotalUsd !== null && value('total') >= Number(key.budgetTotalUsd)) {
    compensate()
    // No Retry-After: a total budget never recovers on its own, and naming a
    // time would promise something no clock will deliver.
    throw new LimitExceededError({
      code: 'insufficient_quota',
      message: `This API key has reached its total budget of $${key.budgetTotalUsd}.`,
      headers: {},
    })
  }

  return snapshot
}

/**
 * Records what the request actually used, once it is known.
 *
 * Never throws: this runs after the response and must not be able to fail one.
 */
export async function chargeUsage(
  key: KeyLimits,
  tokens: number,
  costUsd: string | null,
  now: number = Date.now(),
): Promise<void> {
  if (!hasLimits(key)) return

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []

  if (key.tpmLimit !== null && tokens > 0) {
    ops.push({
      key: windowKey('tpm', key.id, bucket), kind: 'int', by: tokens,
      ttlSeconds: WINDOW_TTL_SECONDS,
    })
  }

  // null, not 0: an unpriced model measured no money, and a budget must not
  // be spent by a number nobody measured.
  const cost = costUsd === null ? 0 : Number(costUsd)
  if (cost > 0) {
    if (key.budgetMonthlyUsd !== null) {
      ops.push({
        key: monthlySpendKey(key.id, now), kind: 'float', by: cost,
        ttlSeconds: MONTH_TTL_SECONDS,
      })
    }
    if (key.budgetTotalUsd !== null) {
      ops.push({ key: totalSpendKey(key.id), kind: 'float', by: cost })
    }
  }

  if (ops.length === 0) return
  try {
    await getUsageStore().apply(ops)
  } catch (err) {
    reportFailure(err)
  }
}

/** Absent headers are honest about a check that did not happen; headers
 * computed from nothing would not be. */
export function rateLimitHeaders(snapshot: LimitSnapshot | null): Record<string, string> {
  if (!snapshot) return {}
  const headers: Record<string, string> = {}
  if (snapshot.rpm) {
    headers['x-ratelimit-limit-requests'] = String(snapshot.rpm.limit)
    headers['x-ratelimit-remaining-requests'] = String(snapshot.rpm.remaining)
    headers['x-ratelimit-reset-requests'] = String(snapshot.rpm.resetSeconds)
  }
  if (snapshot.tpm) {
    headers['x-ratelimit-limit-tokens'] = String(snapshot.tpm.limit)
    headers['x-ratelimit-remaining-tokens'] = String(snapshot.tpm.remaining)
    headers['x-ratelimit-reset-tokens'] = String(snapshot.tpm.resetSeconds)
  }
  return headers
}

/**
 * Reads every listed key's counters in one round trip, for the Keys page.
 *
 * A key with no limits reads as all-null: it has no counters, and showing it
 * a zero would claim it had never been used.
 */
export async function readUsage(
  keys: KeyLimits[],
  now: number = Date.now(),
): Promise<Map<string, UsageReading>> {
  const empty: UsageReading = { rpm: null, tpm: null, monthUsd: null, totalUsd: null }
  const readings = new Map<string, UsageReading>(keys.map((key) => [key.id, { ...empty }]))

  const bucket = bucketOf(now)
  const ops: CounterOp[] = []
  const slots: Array<{ id: string; field: keyof UsageReading; kind: 'window' | 'value' }> = []

  for (const key of keys) {
    if (key.rpmLimit !== null) {
      ops.push({ key: windowKey('rpm', key.id, bucket), kind: 'int', by: 0 })
      ops.push({ key: windowKey('rpm', key.id, bucket - 1), kind: 'int', by: 0 })
      slots.push({ id: key.id, field: 'rpm', kind: 'window' })
    }
    if (key.tpmLimit !== null) {
      ops.push({ key: windowKey('tpm', key.id, bucket), kind: 'int', by: 0 })
      ops.push({ key: windowKey('tpm', key.id, bucket - 1), kind: 'int', by: 0 })
      slots.push({ id: key.id, field: 'tpm', kind: 'window' })
    }
    if (key.budgetMonthlyUsd !== null) {
      ops.push({ key: monthlySpendKey(key.id, now), kind: 'float', by: 0 })
      slots.push({ id: key.id, field: 'monthUsd', kind: 'value' })
    }
    if (key.budgetTotalUsd !== null) {
      ops.push({ key: totalSpendKey(key.id), kind: 'float', by: 0 })
      slots.push({ id: key.id, field: 'totalUsd', kind: 'value' })
    }
  }

  if (ops.length === 0) return readings

  let values: number[]
  try {
    values = await getUsageStore().apply(ops)
  } catch (err) {
    // The page renders em dashes rather than failing; the Governance tab is
    // where an unreachable store gets explained.
    reportFailure(err)
    return readings
  }

  let at = 0
  for (const slot of slots) {
    const reading = readings.get(slot.id)!
    if (slot.kind === 'window') {
      reading[slot.field] = Math.max(0, Math.round(estimate(values[at + 1], values[at], now)))
      at += 2
    } else {
      reading[slot.field] = values[at]
      at += 1
    }
  }
  return readings
}

/**
 * Forgets a key's counters. The total spend counter has no expiry, so without
 * this a deleted key's spend would outlive it forever.
 *
 * Never throws — deleting a key must not fail because the counter store is
 * down — but returns whether the counters actually went away, so a caller
 * that is about to tell an admin "usage reset" can tell the truth instead.
 */
export async function clearUsage(keyId: string, now: number = Date.now()): Promise<boolean> {
  try {
    await getUsageStore().del(allKeysFor(keyId, now))
    return true
  } catch (err) {
    reportFailure(err)
    return false
  }
}
