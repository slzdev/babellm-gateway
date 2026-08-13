import 'server-only'
import { db, pool } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { DRIVERS, resolveRequestLogStore } from './registry'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from the
 * migration runner's key in scripts/migrate.mjs. */
export const PRUNE_LOCK_KEY = BigInt(5_512_998_004_117_336)

const HOUR_MS = 60 * 60 * 1000

/**
 * Deletes expired request logs.
 *
 * Prunes every registered driver, not just the one currently configured for
 * reads: switching the active store must not silently stop retention on data
 * that still exists in a store the gateway simply isn't reading from anymore.
 * request_logs/request_payloads hold captured prompt and completion content,
 * so leaving them unpruned after a store switch would be a data-retention
 * bug, not a cosmetic one. A driver with no retention concept (stdout)
 * contributes 0 and is otherwise harmless in the loop.
 *
 * Returns the number of rows removed, or null when the run was skipped —
 * retention is disabled, or another instance is already pruning.
 */
export async function pruneRequestLogs(now: Date = new Date()): Promise<number | null> {
  const { settings: config } = await resolveRequestLogStore()
  if (config.retentionDays <= 0) return null

  // pg_try_advisory_lock / pg_advisory_unlock are scoped to the session that
  // took them. `db` wraps a shared pool: a bare db.execute() checks out
  // *some* idle client, runs one statement, and hands it back, so the lock
  // and its unlock could land on two different backends. The unlock would
  // then silently no-op on a connection that never held the lock, leaking it
  // on the one that did — and with pg_try_advisory_lock, every later prune
  // would just find it still held and skip, with no error anywhere. Pinning
  // both calls to one held client (as syncProvider in catalog/sync.ts does)
  // is what keeps them on the same session.
  const client = await pool.connect()
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [PRUNE_LOCK_KEY.toString()],
    )
    if (!locked.rows[0]?.locked) return null

    try {
      const cutoff = new Date(now.getTime() - config.retentionDays * 24 * HOUR_MS)
      let deleted = 0
      for (const driver of Object.values(DRIVERS)) {
        deleted += await driver.prune(cutoff)
      }

      await db
        .insert(settings)
        .values({
          key: 'logs.last_prune',
          value: { at: new Date().toISOString(), deleted },
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: { at: new Date().toISOString(), deleted }, updatedAt: new Date() },
        })

      return deleted
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [PRUNE_LOCK_KEY.toString()])
      } catch (err) {
        // The prune's own outcome (its return value, and the last_prune row)
        // is already decided by this point. Rethrowing here would replace a
        // real failure from store.prune with the unlock's instead, hiding the
        // root cause — so it's logged and carried to release() below, which
        // destroys the client rather than recycling one that may still hold
        // the lock.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error('[gateway] could not release the retention prune lock', err)
      }
    }
  } finally {
    client.release(unlockError)
  }
}

let timer: NodeJS.Timeout | null = null

/** Starts the hourly prune. Idempotent, because Next may evaluate a module
 * more than once in development. */
export function startRetentionTimer(): void {
  if (timer) return
  timer = setInterval(() => {
    void pruneRequestLogs().catch((err) =>
      console.error('[gateway] request log pruning failed', err),
    )
  }, HOUR_MS)
  // Never hold the process open for a log-cleanup timer.
  timer.unref()
}
