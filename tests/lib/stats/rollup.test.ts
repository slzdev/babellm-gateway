import { beforeEach, expect, test } from 'vitest'
import { asc } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import { SEAL_LAG_HOURS, addHours, hourStart } from '@/lib/stats/buckets'
import { ROLLUP_LOCK_KEY, runUsageRollup } from '@/lib/stats/rollup'
import { readRollupState, writeRollupState } from '@/lib/stats/state'
import { PARTITION_LOCK_KEY } from '@/lib/logs/maintenance'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const NOW = new Date('2026-08-14T13:20:00Z')
const at = (iso: string) => new Date(iso)

async function rollups() {
  return db.select().from(usageRollups).orderBy(asc(usageRollups.bucket))
}

// pg_try_advisory_lock's single-bigint form stores the key split across two
// int4 catalog columns — classid the high 32 bits, objid the low 32 bits,
// both reinterpreted as signed (Postgres's SET_LOCKTAG_ADVISORY casts via
// uint32 then stores as int4 — BigInt.asIntN(32, ...) is the same
// reinterpretation) — with objsubid = 1 marking the bigint form specifically
// (the two-int4 form of the function sets objsubid = 2 instead). pg_locks is
// instance-global, so any connection can see a lock taken by another one —
// that is what lets this check outlive the session that took the lock,
// unlike asserting via a second tick's outcome.
//
// Verified directly against Postgres before trusting this: held
// pg_advisory_lock($1) with KEY = ROLLUP_LOCK_KEY from a throwaway
// connection, dumped pg_locks, and confirmed classid/objid computed this way
// matched the live row exactly (1795870 / 1641062621), then confirmed the
// same query found nothing after pg_advisory_unlock.
async function rollupLockHeld(): Promise<boolean> {
  const classid = Number(BigInt.asIntN(32, ROLLUP_LOCK_KEY >> BigInt(32)))
  const objid = Number(BigInt.asIntN(32, ROLLUP_LOCK_KEY & BigInt(0xffffffff)))
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_locks
     WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1
     LIMIT 1`,
    [classid, objid],
  )
  return rows.length > 0
}

test('the lock key is not the partition maintenance key', () => {
  // Sharing one would make a per-minute job and a daily job block each other
  // for no reason.
  expect(ROLLUP_LOCK_KEY).not.toBe(PARTITION_LOCK_KEY)
})

test('a tick aggregates the unsealed window', async () => {
  await insertLog({ at: at('2026-08-14T12:30:00Z') })
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  const run = await runUsageRollup(NOW)

  // 12:00, not the window's own 11:00: the recompute never descends below the oldest
  // surviving log, because an hour with no source rows would be deleted and
  // not reinserted. The oldest log here starts at 12:30.
  expect(run?.recomputed?.from.toISOString()).toBe('2026-08-14T12:00:00.000Z')
  expect(run?.recomputed?.to.toISOString()).toBe('2026-08-14T14:00:00.000Z')
  expect((await rollups()).map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T12:00:00.000Z',
    '2026-08-14T13:00:00.000Z',
  ])
})

test('the watermark advances but leaves the lag open', async () => {
  await runUsageRollup(NOW)

  const state = await readRollupState(NOW)
  expect(state.sealedThrough.toISOString()).toBe('2026-08-14T11:00:00.000Z')
})

test('two ticks produce the same rows', async () => {
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  await runUsageRollup(NOW)
  const first = await rollups()
  await runUsageRollup(NOW)

  expect(await rollups()).toEqual(first)
})

test('a row arriving late but inside the seal lag is picked up', async () => {
  // The row's id says 12:59 — a stream that started then and finished now.
  // Hour 12 was already computed by the first tick and must be recomputed.
  await runUsageRollup(NOW)
  expect(await rollups()).toHaveLength(0)

  await insertLog({ at: at('2026-08-14T12:59:00Z') })
  await runUsageRollup(NOW)

  const rows = await rollups()
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket.toISOString()).toBe('2026-08-14T12:00:00.000Z')
})

test('a row arriving in an hour both recompute and backfill have passed is missed', async () => {
  // SEAL_LAG_HOURS bounds recompute's watermark only — it says nothing about
  // backfill. Backfill sweeps toward oldestLog by construction, so a row
  // landing in an hour backfill hasn't reached yet is still picked up no
  // matter how old that hour's wall-clock time is; on a fresh or
  // still-backfilling database that is correct, not a bug. An hour is
  // genuinely unreachable only once BOTH mechanisms have passed it, so the
  // state here is built directly rather than via tick sequencing — letting
  // ticks produce it risks the late row becoming the table's only (and thus
  // its oldest) log, which would make backfill's first chunk sweep straight
  // into the very hour this test means to put out of reach.
  await insertLog({ at: at('2026-08-10T00:30:00Z') })

  await writeRollupState({
    // Recompute only ever covers hours after sealedThrough, so this is the
    // real boundary SEAL_LAG_HOURS produces: the unsealed window starts at
    // 12:00, never touching hour 09:00.
    sealedThrough: addHours(hourStart(NOW), -SEAL_LAG_HOURS),
    // Backfill's next chunk ends at 08:00, already past hour 09:00.
    backfilledTo: at('2026-08-14T08:00:00Z'),
    oldestLog: at('2026-08-10T00:00:00Z'),
  }, NOW)

  await insertLog({ at: at('2026-08-14T09:30:00Z') })
  await runUsageRollup(NOW)

  expect(await rollups()).toHaveLength(0)
})

test('an hour whose source logs are gone keeps its rollup row', async () => {
  // Rollups are kept forever and outlive the partitions they were computed
  // from (§9) — that promise is the whole reason this is a table and not a
  // materialized view. The recompute is DELETE-then-INSERT over a bucket
  // range, so recomputing an hour whose logs have been dropped deletes the
  // history and reinserts nothing.
  await insertLog({ at: at('2026-08-14T12:30:00Z') })
  await runUsageRollup(NOW)
  expect(await rollups()).toHaveLength(1)

  // dropExpiredPartitions has since taken the partition holding that hour.
  // From the recompute's point of view dropping the rows is the same event:
  // the id range now selects nothing at all.
  await pool.query('DELETE FROM request_logs')

  // An instance returning after downtime longer than the retention window
  // finds a stale watermark, and unsealedRange sweeps forward from it across
  // the hours whose logs are gone.
  const state = await readRollupState(NOW)
  await writeRollupState({ ...state, sealedThrough: at('2026-08-14T10:00:00Z') }, NOW)

  await runUsageRollup(NOW)

  expect(await rollups()).toHaveLength(1)
  // And the watermark still moves: those hours will never have source rows
  // again, so leaving them unsealed would make every later tick reconsider
  // them forever.
  expect((await readRollupState(NOW)).sealedThrough.toISOString())
    .toBe('2026-08-14T11:00:00.000Z')
})

test('a partly dropped window recomputes only the hours that still have logs', async () => {
  await writeRollupState(
    { sealedThrough: at('2026-08-14T09:00:00Z'), backfilledTo: null, oldestLog: null },
    NOW,
  )
  const dropped = await insertLog({ at: at('2026-08-14T10:30:00Z') })
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  await runUsageRollup(NOW)
  expect((await rollups()).map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T10:00:00.000Z',
    '2026-08-14T13:00:00.000Z',
  ])

  // Only the older hour ages out. The window now straddles the boundary:
  // hour 10 has no source rows left, hour 13 still does.
  await pool.query('DELETE FROM request_logs WHERE id = $1', [dropped])
  await writeRollupState(
    { ...(await readRollupState(NOW)), sealedThrough: at('2026-08-14T09:00:00Z') },
    NOW,
  )

  const run = await runUsageRollup(NOW)

  const rows = await rollups()
  expect(rows.map((r) => r.bucket.toISOString())).toEqual([
    '2026-08-14T10:00:00.000Z',
    '2026-08-14T13:00:00.000Z',
  ])
  expect(rows[1].requests).toBe(1)
  expect(run?.recomputed?.from.toISOString()).toBe('2026-08-14T13:00:00.000Z')
})

test('a held lock makes the tick skip rather than run concurrently', async () => {
  // Two instances interleaving inside DELETE-then-INSERT can leave an hour
  // permanently zeroed, and the unique constraint cannot catch it because
  // deleting rows violates nothing.
  const holder = await pool.connect()
  try {
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])
    // Also doubles as validation of rollupLockHeld()'s classid/objid
    // reconstruction: a lock deliberately held right here must be found,
    // or the negative assertion below would pass trivially for the wrong
    // reason (matching nothing, rather than confirming nothing is held).
    expect(await rollupLockHeld()).toBe(true)

    expect(await runUsageRollup(NOW)).toBeNull()
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [ROLLUP_LOCK_KEY.toString()])
    holder.release()
  }
})

test('the lock is released, so the next tick runs', async () => {
  // The trap this guards: a lock taken on one pooled client and released on
  // another leaks silently, and every later tick skips forever. A second
  // tick succeeding is NOT sufficient proof of that on its own: node-postgres
  // returns a released client to the idle pool and hands the very next
  // pool.connect() the same backend, and advisory locks are re-entrant
  // within a session — so a leaked lock's own session would happily
  // re-acquire it and this test would stay green anyway. Asserting against
  // pg_locks from a separate connection is what actually distinguishes
  // "released" from "leaked but re-entered."
  await runUsageRollup(NOW)
  await insertLog({ at: at('2026-08-14T13:05:00Z') })

  expect(await runUsageRollup(NOW)).not.toBeNull()
  expect(await rollups()).toHaveLength(1)
  expect(await rollupLockHeld()).toBe(false)
})

test('backfill walks backwards into history over successive ticks', async () => {
  await insertLog({ at: at('2026-08-11T09:30:00Z') })
  await insertLog({ at: at('2026-08-13T09:30:00Z') })

  // First tick: the unsealed window only, and history is not yet covered.
  await runUsageRollup(NOW)
  expect(await rollups()).toHaveLength(0)

  // Each further tick pulls one day older.
  await runUsageRollup(NOW)
  expect((await rollups()).map((r) => r.bucket.toISOString()))
    .toContain('2026-08-13T09:00:00.000Z')

  for (let i = 0; i < 4; i += 1) await runUsageRollup(NOW)

  expect((await rollups()).map((r) => r.bucket.toISOString()))
    .toContain('2026-08-11T09:00:00.000Z')
})

test('backfill stops once the oldest log is covered', async () => {
  await insertLog({ at: at('2026-08-13T09:30:00Z') })

  for (let i = 0; i < 6; i += 1) await runUsageRollup(NOW)
  const state = await readRollupState(NOW)

  const run = await runUsageRollup(NOW)
  expect(run?.backfilled).toBeNull()
  expect((await readRollupState(NOW)).backfilledTo?.toISOString())
    .toBe(state.backfilledTo?.toISOString())
})

test('a long catch-up is chunked rather than done in one transaction', async () => {
  // Sealed a year ago: the tick must cover MAX_HOURS_PER_TICK and no more.
  // The log is older than the whole catch-up window, so the oldest-log clamp
  // has nothing to trim off the front of it — this is about the cap, not
  // about the clamp.
  await insertLog({ at: at('2026-08-14T00:30:00Z') })
  await runUsageRollup(NOW)
  const { sealedThrough } = await readRollupState(NOW)
  const later = addHours(sealedThrough, 24 * 400)

  const run = await runUsageRollup(later)

  const hours = (run!.recomputed!.to.getTime() - run!.recomputed!.from.getTime()) / 3_600_000
  expect(hours).toBe(168)
})
