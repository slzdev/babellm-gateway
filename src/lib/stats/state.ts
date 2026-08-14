import 'server-only'
import { db, pool } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { initialSealedThrough } from './buckets'
import { bucketExpr } from './sql'

/** One settings row, the same pattern as `logs.last_maintenance`. */
export const ROLLUP_STATE_KEY = 'usage.rollup_state'

export interface RollupState {
  /** The last hour considered final. Recompute starts at the hour after it. */
  sealedThrough: Date
  /** The oldest hour the backfill has reached. Null until the first tick. */
  backfilledTo: Date | null
  /** The hour of the earliest surviving request log. Null until measured. */
  oldestLog: Date | null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Reads the watermark, degrading to a fresh start on anything unreadable.
 *
 * A hand-edited or half-written settings row must not wedge the job forever:
 * the worst case of starting over is a redundant recompute of the unsealed
 * window, which is idempotent anyway.
 */
export async function readRollupState(now: Date): Promise<RollupState> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ROLLUP_STATE_KEY))
  const value = (row?.value ?? {}) as Record<string, unknown>

  return {
    sealedThrough: parseDate(value.sealedThrough) ?? initialSealedThrough(now),
    backfilledTo: parseDate(value.backfilledTo),
    oldestLog: parseDate(value.oldestLog),
  }
}

export async function writeRollupState(state: RollupState, now: Date): Promise<void> {
  const value = {
    sealedThrough: state.sealedThrough.toISOString(),
    backfilledTo: state.backfilledTo?.toISOString() ?? null,
    oldestLog: state.oldestLog?.toISOString() ?? null,
    at: now.toISOString(),
  }

  await db
    .insert(settings)
    .values({ key: ROLLUP_STATE_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
}

/**
 * The hour of the earliest surviving request log, or null if there are none.
 *
 * Measured once and stored, because it only moves when a partition is
 * dropped — and a stale value merely makes the backfill walk into empty
 * hours, which costs one no-op recompute and then finishes.
 *
 * Uses ORDER BY … LIMIT 1 instead of min(id) because min(uuid) does not exist
 * before Postgres 18. The obvious workaround `min(id::text)` applies a function
 * to the column, which disables the primary key index and forces a seq-scan of
 * the entire request_logs table — the largest in the system. A direct ordered
 * index scan is much faster, especially on first boot when there is most history.
 */
export async function oldestLogHour(): Promise<Date | null> {
  const { rows: minRows } = await pool.query(
    `SELECT id FROM request_logs ORDER BY id LIMIT 1`,
  )
  if (!minRows[0]) return null

  const { rows: hourRows } = await pool.query(
    `SELECT ${bucketExpr('t')} AS hour FROM (SELECT $1::uuid AS id) t`,
    [minRows[0].id],
  )
  return (hourRows[0]?.hour as Date | undefined) ?? null
}
