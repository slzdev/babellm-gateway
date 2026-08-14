import { beforeEach, expect, test } from 'vitest'
import { DEFAULT_RETENTION_MONTHS, getLoggingSettings, setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../helpers/db'

beforeEach(resetDb)

test('defaults to the postgres store with 3 month retention', async () => {
  expect(await getLoggingSettings()).toEqual({
    store: 'postgres',
    retentionMonths: 3,
    payloadMaxBytes: 262144,
  })
})

test('persists a patch and leaves the rest alone', async () => {
  // Any name round-trips: this layer stores the operator's choice, and it is
  // the registry that decides whether a driver by that name exists.
  await setLoggingSettings({ store: 'clickhouse' })
  expect(await getLoggingSettings()).toMatchObject({ store: 'clickhouse', retentionMonths: 3 })

  await setLoggingSettings({ retentionMonths: 7 })
  expect(await getLoggingSettings()).toMatchObject({ store: 'clickhouse', retentionMonths: 7 })
})

test('retention is stored in months and rejects fractions and negatives', async () => {
  expect((await setLoggingSettings({ retentionMonths: 6 })).retentionMonths).toBe(6)
  expect((await setLoggingSettings({ retentionMonths: 0 })).retentionMonths).toBe(0)
  await expect(setLoggingSettings({ retentionMonths: -1 })).rejects.toThrow(/whole number of months/)
  await expect(setLoggingSettings({ retentionMonths: 1.5 })).rejects.toThrow(/whole number of months/)
})

test('retention falls back to the default when unset', async () => {
  expect((await getLoggingSettings()).retentionMonths).toBe(DEFAULT_RETENTION_MONTHS)
})

test('rejects a non-positive payload cap', async () => {
  await expect(setLoggingSettings({ payloadMaxBytes: 0 })).rejects.toThrow(/payload/i)
})

test('rejects an empty store name', async () => {
  await expect(setLoggingSettings({ store: '  ' })).rejects.toThrow(/store/i)
})
