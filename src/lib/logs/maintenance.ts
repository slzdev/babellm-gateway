import 'server-only'
import { db, pool } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { DRIVERS, resolveRequestLogStore } from './registry'
import type { MaintenanceResult } from './types'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from the
 * migration runner's key in scripts/migrate.mjs. */
export const PARTITION_LOCK_KEY = BigInt(5_512_998_004_117_336)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Provisions request-log partitions ahead of time and drops those that have
 * aged out of the retention window.
 *
 * Maintains every registered driver, not just the one currently configured
 * for reads: switching the active store must not silently stop retention on
 * data that still exists in a store the gateway is no longer reading from.
 * request_logs holds captured prompt and completion content, so leaving it
 * unmaintained after a store switch would be a data-retention bug rather than
 * a cosmetic one. A driver with no storage of its own contributes nothing and
 * is harmless in the loop.
 *
 * Returns what was created and dropped, or null when another instance is
 * already running.
 */
export async function runLogMaintenance(
  now: Date = new Date(),
): Promise<MaintenanceResult | null> {
  const { settings: config } = await resolveRequestLogStore()

  // pg_try_advisory_lock / pg_advisory_unlock are scoped to the session that
  // took them. `db` wraps a shared pool: a bare db.execute() checks out
  // *some* idle client, runs one statement, and hands it back, so the lock
  // and its unlock could land on two different backends. The unlock would
  // then silently no-op on a connection that never held the lock, leaking it
  // on the one that did — and with pg_try_advisory_lock, every later run
  // would just find it still held and skip, with no error anywhere. Pinning
  // both calls to one held client is what keeps them on the same session.
  const client = await pool.connect()
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [PARTITION_LOCK_KEY.toString()],
    )
    if (!locked.rows[0]?.locked) return null

    try {
      const result: MaintenanceResult = { created: [], dropped: [] }
      for (const driver of Object.values(DRIVERS)) {
        const done = await driver.maintain(now, config)
        result.created.push(...done.created)
        result.dropped.push(...done.dropped)
      }

      const value = { at: new Date().toISOString(), ...result }
      await db
        .insert(settings)
        .values({ key: 'logs.last_maintenance', value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        })

      return result
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [PARTITION_LOCK_KEY.toString()])
      } catch (err) {
        // The run's own outcome is already decided by this point. Rethrowing
        // here would replace a real failure from driver.maintain with the
        // unlock's instead, hiding the root cause — so it is logged and
        // carried to release() below, which destroys the client rather than
        // recycling one that may still hold the lock.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error('[gateway] could not release the log maintenance lock', err)
      }
    }
  } finally {
    client.release(unlockError)
  }
}

let timer: NodeJS.Timeout | null = null

/**
 * Runs maintenance once, now, and then daily.
 *
 * The first run is awaited before the instance serves anything. There is no
 * DEFAULT partition, so a database whose partitions do not exist yet cannot
 * accept a log write at all — a fresh install is provisioned by this call.
 *
 * A failure here is logged and swallowed rather than propagated: a logging
 * problem must not become a serving problem. It is logged loudly because the
 * consequence is silently discarded log lines rather than a visibly degraded
 * page, and that is not something an operator can be left to discover.
 *
 * Idempotent, because Next may evaluate a module more than once in
 * development.
 */
export async function startPartitionMaintenance(): Promise<void> {
  if (timer) return

  timer = setInterval(() => {
    void runLogMaintenance().catch((err) =>
      console.error('[gateway] request log maintenance failed', err),
    )
  }, DAY_MS)
  // Never hold the process open for a log-housekeeping timer.
  timer.unref()

  try {
    await runLogMaintenance()
  } catch (err) {
    console.error('[gateway] initial request log maintenance failed', err)
  }
}
