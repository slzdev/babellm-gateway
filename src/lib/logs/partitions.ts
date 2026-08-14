import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'
import { addMonths, monthStart } from './months'

/** Months provisioned beyond the current one. There is no DEFAULT partition
 * to catch a write for an unprovisioned month, so this lead time is the only
 * thing standing between a broken maintenance job and lost log lines: the job
 * must fail continuously for a full quarter, through every boot and every
 * daily tick, before a write can find no home. */
export const MONTHS_AHEAD = 3

const PARTITION_RE = /^request_logs_(\d{4})_(\d{2})$/

export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

export { addMonths, monthStart } from './months'

export function partitionName(date: Date): string {
  const start = monthStart(date)
  const month = String(start.getUTCMonth() + 1).padStart(2, '0')
  return `request_logs_${start.getUTCFullYear()}_${month}`
}

/** The lowest uuid that can be written in `date`'s month — the partition's
 * lower bound, and the next month's exclusive upper bound. */
export function monthBound(date: Date): string {
  return uuidv7Bound(monthStart(date))
}

/**
 * Creates the current month's partition and the next `MONTHS_AHEAD`.
 * Returns the names actually created, so a caller can report real work rather
 * than a fixed list that says the same thing on every run.
 *
 * `IF NOT EXISTS` makes this idempotent, which is what lets it run at every
 * boot and on every tick without a "have I already done this" query.
 *
 * Each statement takes a brief AccessExclusiveLock on the parent, blocking
 * writes for its duration. That is sub-millisecond for an empty new partition,
 * and it is the reason partitions are made months ahead by a background job
 * rather than on the insert path.
 */
export async function ensurePartitions(client: Queryable, now: Date): Promise<string[]> {
  const created: string[] = []

  for (let ahead = 0; ahead <= MONTHS_AHEAD; ahead += 1) {
    const start = addMonths(now, ahead)
    const name = partitionName(start)
    const { rows } = await client.query(`
      SELECT to_regclass('public.${name}') IS NULL AS missing
    `)
    if (rows[0]?.missing !== true) continue

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.${name} PARTITION OF public.request_logs
      FOR VALUES FROM ('${monthBound(start)}') TO ('${monthBound(addMonths(start, 1))}')
    `)
    created.push(name)
  }

  return created
}

/**
 * Drops every month that falls outside the keep window: the current month and
 * the `retentionMonths - 1` before it. `0` keeps everything.
 *
 * The partitions are read from the catalog rather than computed as a list of
 * names to delete. The catalog is the truth — a partition left by an older
 * naming scheme, or created by hand, is visible this way and invisible the
 * other. Anything whose name does not parse as request_logs_YYYY_MM is left
 * alone: this module drops what it made, not whatever it finds attached.
 */
export async function dropExpiredPartitions(
  client: Queryable,
  now: Date,
  retentionMonths: number,
): Promise<string[]> {
  if (retentionMonths <= 0) return []

  const keepFrom = addMonths(now, -(retentionMonths - 1))
  const { rows } = await client.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname = 'request_logs' AND pn.nspname = 'public'
    ORDER BY c.relname
  `)

  const dropped: string[] = []
  for (const row of rows) {
    const name = String(row.name)
    const match = PARTITION_RE.exec(name)
    if (!match) continue

    const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
    if (start >= keepFrom) continue

    await client.query(`DROP TABLE IF EXISTS public.${name}`)
    dropped.push(name)
  }

  return dropped
}
