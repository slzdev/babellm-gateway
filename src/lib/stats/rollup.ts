import 'server-only'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { aggregateRange } from './aggregate'
import {
  backfillChunk, hourStart, nextSealedThrough, unsealedRange, type HourRange,
} from './buckets'
import { oldestLogHour, readRollupState, writeRollupState } from './state'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from
 * PARTITION_LOCK_KEY in src/lib/logs/maintenance.ts — a per-minute job and a
 * daily job must not block each other. */
export const ROLLUP_LOCK_KEY = BigInt(7_713_204_558_930_141)

export interface RollupRun {
  recomputed: HourRange | null
  rows: number
  backfilled: HourRange | null
}

/**
 * One rollup tick: recompute the unsealed window, advance the watermark, and
 * pull one chunk of history backwards.
 *
 * Returns null when another instance holds the lock.
 *
 * `pg_try_advisory_lock`, not the blocking form: a losing tick means someone
 * else is already doing this minute's work, and the next tick is 60 seconds
 * away. Blocking would queue ticks behind each other and stack them without
 * bound if one wedged. (runLogMaintenance blocks on the boot path for the
 * opposite reason: an instance must not start serving with no partitions.)
 */
export async function runUsageRollup(now: Date = new Date()): Promise<RollupRun | null> {
  // pg_try_advisory_lock and pg_advisory_unlock are scoped to the session
  // that took them. `db` wraps a shared pool: a bare db.execute() checks out
  // *some* idle client, runs one statement and hands it back, so the lock and
  // its unlock could land on two different backends. The unlock would no-op
  // on a connection that never held the lock, leaking it on the one that did
  // — and every later tick would then find it held and skip, forever, with
  // nothing in the logs. Pinning both calls to one client is the fix.
  const client = await pool.connect()
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [ROLLUP_LOCK_KEY.toString()],
    )
    if (!locked.rows[0]?.locked) return null

    try {
      const state = await readRollupState(now)
      const run: RollupRun = { recomputed: null, rows: 0, backfilled: null }

      // Measured fresh, and deliberately not read from `state.oldestLog`.
      // That value is cached on purpose — it only moves when a partition is
      // dropped — and a stale one is harmless for the backfill below, which
      // only ever descends into hours it has never written. It is not
      // harmless for the clamp that follows, which is a decision about
      // deleting rows.
      const oldestLog = await oldestLogHour()

      const unsealed = unsealedRange(state.sealedThrough, now)
      if (unsealed) {
        // Never recompute an hour that has no source data left.
        //
        // The recompute is DELETE-then-INSERT over a bucket range, so an
        // hour whose partition dropExpiredPartitions has already dropped
        // loses its rollup row to the DELETE and gets nothing back from the
        // INSERT — permanently zeroing usage history that §9 promises
        // outlives the request-log retention window. An instance returning
        // after downtime longer than that window walks straight into it:
        // unsealedRange sweeps forward from a stale watermark, and
        // instrumentation.ts makes it likelier still by running partition
        // maintenance first on the same boot. Restoring an older backup
        // reaches it the same way.
        //
        // Skipping those hours costs nothing — they hold no rows to
        // aggregate — so the watermark still advances across the gap below.
        // It just advances without deleting anything.
        const floor = oldestLog ? hourStart(oldestLog) : null
        const recompute = floor && floor < unsealed.to
          ? { from: floor > unsealed.from ? floor : unsealed.from, to: unsealed.to }
          : null

        if (recompute) {
          // One transaction: a DELETE that committed without its INSERT
          // would leave those hours permanently zeroed.
          run.rows += await inTransaction(client, recompute)
          run.recomputed = recompute
        }

        // Advanced over the whole unsealed window, including any skipped
        // gap: those hours have no source rows and never will again, so
        // leaving them unsealed would only make every later tick reconsider
        // them forever.
        state.sealedThrough = nextSealedThrough(state.sealedThrough, unsealed, now)
        // The first tick establishes where history begins for the backfill:
        // everything from here backwards is its job.
        state.backfilledTo ??= unsealed.from
      }

      state.oldestLog ??= oldestLog

      if (state.backfilledTo && state.oldestLog) {
        const chunk = backfillChunk(state.backfilledTo, state.oldestLog)
        if (chunk) {
          run.rows += await inTransaction(client, chunk)
          run.backfilled = chunk
          state.backfilledTo = chunk.from
        }
      }

      await writeRollupState(state, now)
      return run
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])
      } catch (err) {
        // The run's outcome is already decided. Rethrowing here would replace
        // a real failure from the aggregation with the unlock's and hide the
        // root cause, so it is logged and carried to release() below, which
        // destroys a client that may still hold the lock rather than
        // recycling it.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error('[gateway] could not release the usage rollup lock', err)
      }
    }
  } finally {
    client.release(unlockError)
  }
}

// `PoolClient`, not `Awaited<ReturnType<typeof pool.connect>>`. pg's
// `Pool.connect` is overloaded — a `Promise<PoolClient>` form and a callback
// form returning `void` — and TypeScript's `ReturnType` on an overloaded
// function picks the *last* declared signature, not the one actually
// selected at the call site. That resolves to `void`, not `PoolClient`. Do
// not "simplify" this back to the derived form.
async function inTransaction(
  client: PoolClient,
  range: HourRange,
): Promise<number> {
  await client.query('BEGIN')
  try {
    const rows = await aggregateRange(client, range)
    await client.query('COMMIT')
    return rows
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // A dead connection is a common way the aggregation failure itself
      // presents, and ROLLBACK on a dead connection fails too. Rethrowing
      // that instead would replace the real cause (`err`) with a
      // consequence of it, hiding what actually went wrong — so it is only
      // logged, the same way the unlock path above lets the run's real
      // outcome win over a failure to clean up after it.
      console.error('[gateway] could not roll back the usage rollup transaction', rollbackErr)
    }
    throw err
  }
}

export const ROLLUP_TICK_MS = 900_000 // 15 minutes

let timer: NodeJS.Timeout | null = null

/**
 * The tick currently in flight, as a promise that always *settles* rather
 * than rejecting — the failure is logged inside, so awaiting this can never
 * turn a swallowed reporting failure into an unhandled rejection.
 */
let inFlight: Promise<void> = Promise.resolve()

function runTick(label: string): void {
  inFlight = runUsageRollup().then(
    () => undefined,
    (err: unknown) => { console.error(label, err) },
  )
}

/**
 * Resolves when the tick currently in flight has finished, or immediately if
 * none is.
 *
 * For tests. Nothing in production waits for a tick — that is the whole point
 * of startUsageRollup being non-blocking — but a test that starts the job and
 * returns leaves a tick still holding a pooled client mid-transaction, and the
 * next test file's resetDb needs ACCESS EXCLUSIVE on those tables to
 * TRUNCATE. The failure then lands in an unrelated file and looks like
 * someone else's bug, which is exactly what happened. Polling for a tick's
 * side effects is not enough: the tick still has the state write, the unlock
 * and the release to do after the rows land.
 */
export function whenTickSettles(): Promise<void> {
  return inFlight
}

/**
 * Runs one tick now, then every ROLLUP_TICK_MS.
 *
 * The first run is started but **not** awaited, so `register()` never blocks
 * serving on it. Awaiting would be attractive for a fresh instance — it would
 * serve a populated dashboard rather than an empty one — but the same call is
 * a catch-up on an instance returning from downtime, where it aggregates up
 * to MAX_HOURS_PER_TICK of traffic in one transaction while the gateway
 * serves nothing at all. The interval is already scheduled by then, so the
 * fresh-boot case loses at most one tick's worth of empty dashboard and the
 * catch-up case stops holding the door shut.
 *
 * A failure is logged and swallowed rather than propagated: a reporting
 * problem must not become a serving problem, the same hierarchy of concerns
 * startPartitionMaintenance states. It is logged loudly because the
 * consequence is a silently stale dashboard rather than a visibly broken
 * page.
 *
 * Idempotent, because Next may evaluate a module more than once in
 * development.
 */
export function startUsageRollup(): void {
  if (timer) return

  timer = setInterval(() => {
    runTick('[gateway] usage rollup tick failed')
  }, ROLLUP_TICK_MS)
  // Never hold the process open for a reporting job.
  timer.unref()

  runTick('[gateway] initial usage rollup failed')
}

/**
 * Test teardown. Production never stops the job.
 *
 * Stopping the schedule says nothing about the tick already running, so pair
 * this with `whenTickSettles()` in a test's teardown.
 */
export function stopUsageRollup(): void {
  if (timer) clearInterval(timer)
  timer = null
}
