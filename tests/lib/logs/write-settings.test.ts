import { afterEach, expect, test } from 'vitest'
import { DRIVERS, clearRequestLogStoreCache, logRequest } from '@/lib/logs'
import { setLoggingSettings } from '@/lib/settings'
import { uuidv7 } from '@/lib/uuid'
// LoggingSettings comes from @/lib/settings, not from logs/types — types.ts
// imports it for its own signatures and never re-exports it.
import type { LoggingSettings } from '@/lib/settings'
import type { RequestLogEntry, WriteOnlySink } from '@/lib/logs/types'
import { resetDb } from '../../helpers/db'

const DRIVER = 'test-settings-capture'
let captured: LoggingSettings | null = null

const sink: WriteOnlySink = {
  name: DRIVER,
  readable: false,
  async write(_entry, settings) { captured = settings },
  async maintain() { return { created: [], dropped: [] } },
}

afterEach(async () => {
  delete DRIVERS[DRIVER]
  clearRequestLogStoreCache()
  captured = null
  await resetDb()
})

function entry(): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: null, model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
  }
}

test('logRequest hands the resolved logging settings to the store', async () => {
  await resetDb()
  DRIVERS[DRIVER] = sink
  await setLoggingSettings({ store: DRIVER, retentionMonths: 7 })
  clearRequestLogStoreCache()

  await logRequest(entry())

  // The settings come from the same cached resolution that picked the store,
  // so a driver that needs them (DynamoDB stamps a TTL from retentionMonths)
  // costs no extra query to get them.
  expect(captured?.retentionMonths).toBe(7)
  expect(captured?.store).toBe(DRIVER)
})
