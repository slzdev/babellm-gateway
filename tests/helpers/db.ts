import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { MONTHS_AHEAD, addMonths, ensurePartitions, partitionName } from '@/lib/logs/partitions'

const TABLES = [
  'request_logs',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]

/** The partitions a freshly reset database should have: exactly the set
 * `ensurePartitions` would build for right now. */
function expected(now: Date): Set<string> {
  const names = new Set<string>()
  for (let ahead = 0; ahead <= MONTHS_AHEAD; ahead += 1) {
    names.add(partitionName(addMonths(now, ahead)))
  }
  return names
}

/**
 * Restores the partition set as well as the rows.
 *
 * TRUNCATE empties a partitioned table's partitions but leaves them attached,
 * and it cannot bring back one a test dropped. Tests do both: they provision
 * far-future months and they drop expired ones for real. Without a sweep the
 * database accumulates months across runs, and the next run of an
 * "ensurePartitions created these four" assertion finds them already there —
 * green the first time, red the second.
 *
 * Unlike the production `dropExpiredPartitions`, this drops anything outside
 * the expected set including names that do not parse as a month. That
 * difference is deliberate: production must never delete a table it did not
 * create, while a test fixture wants a known slate. Do not "fix" one to match
 * the other.
 *
 * In the steady state this costs five catalog reads and no DDL: one to
 * enumerate what is attached, and one per expected month to confirm it is
 * already there.
 */
export async function resetDb() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )

  const now = new Date()
  const keep = expected(now)
  const { rows } = await pool.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs'
  `)
  for (const row of rows) {
    const name = String(row.name)
    if (!keep.has(name)) await pool.query(`DROP TABLE IF EXISTS ${name}`)
  }

  await ensurePartitions(pool, now)
}

export { db as testDb }
