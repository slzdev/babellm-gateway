import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { resolveRequestLogStore } from './registry'

/** Arbitrary constant; only has to be stable and unique to this job across
 * everything that talks to this database. Deliberately different from the
 * migration runner's key in scripts/migrate.mjs. */
export const PRUNE_LOCK_KEY = BigInt(5_512_998_004_117_336)

const HOUR_MS = 60 * 60 * 1000

/**
 * Deletes expired request logs.
 *
 * Returns the number of rows removed, or null when the run was skipped —
 * retention is disabled, or another instance is already pruning.
 */
export async function pruneRequestLogs(now: Date = new Date()): Promise<number | null> {
  const { store, settings: config } = await resolveRequestLogStore()
  if (config.retentionDays <= 0) return null

  // A session advisory lock, taken with try_ so a second instance skips
  // instead of queueing behind a prune it would only repeat.
  const acquired = await db.execute(
    sql`SELECT pg_try_advisory_lock(${PRUNE_LOCK_KEY.toString()}::bigint) AS locked`,
  )
  if (!acquired.rows[0]?.locked) return null

  try {
    const cutoff = new Date(now.getTime() - config.retentionDays * 24 * HOUR_MS)
    const deleted = await store.prune(cutoff)

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
    await db.execute(sql`SELECT pg_advisory_unlock(${PRUNE_LOCK_KEY.toString()}::bigint)`)
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
