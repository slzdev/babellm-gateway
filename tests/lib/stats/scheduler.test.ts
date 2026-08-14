import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db, pool } from '@/lib/db'
import { usageRollups } from '@/lib/db/schema'
import {
  ROLLUP_TICK_MS, startUsageRollup, stopUsageRollup, whenTickSettles,
} from '@/lib/stats/rollup'
import { insertLog } from '../../helpers/stats'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)
afterEach(async () => {
  stopUsageRollup()
  // Clearing the interval says nothing about the tick already in flight, and
  // startUsageRollup deliberately does not await it. A tick outliving this
  // file holds a pooled client inside a transaction, and the next file's
  // resetDb needs ACCESS EXCLUSIVE to TRUNCATE — so it fails there, in a file
  // that has nothing to do with the rollup. This is the only place that can
  // wait for it.
  await whenTickSettles()
  vi.restoreAllMocks()
})

test('a tick is scheduled on the rollup interval', () => {
  const setIntervalSpy = vi.spyOn(global, 'setInterval')

  startUsageRollup()

  expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), ROLLUP_TICK_MS)
})

test('the first tick runs without the caller waiting for it', async () => {
  // Scheduling is synchronous: register() must not hold serving open while a
  // catch-up tick aggregates up to a week of traffic in one transaction. The
  // tick still runs — it just runs behind the boot rather than in front of it.
  await insertLog()

  startUsageRollup()
  await whenTickSettles()

  expect(await db.select().from(usageRollups)).not.toHaveLength(0)
})

test('starting twice does not schedule two timers', () => {
  // Next may evaluate a module more than once in development.
  const setIntervalSpy = vi.spyOn(global, 'setInterval')

  startUsageRollup()
  startUsageRollup()

  expect(setIntervalSpy).toHaveBeenCalledOnce()
})

test('a failing tick is logged and swallowed', async () => {
  // A reporting problem must not become a serving problem — the same
  // hierarchy of concerns startPartitionMaintenance states. A database the
  // job cannot reach must not stop the instance from serving requests, and
  // now that the first tick is not awaited it must not surface as an
  // unhandled rejection either: whenTickSettles() resolves here rather than
  // rejecting, which is what keeps the teardown above safe to await.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(pool, 'connect').mockRejectedValueOnce(new Error('boom'))

  expect(startUsageRollup()).toBeUndefined()
  await expect(whenTickSettles()).resolves.toBeUndefined()

  expect(error).toHaveBeenCalled()
})
