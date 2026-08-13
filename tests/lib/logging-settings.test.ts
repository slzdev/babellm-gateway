import { beforeEach, expect, test } from 'vitest'
import { getLoggingSettings, setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../helpers/db'

beforeEach(resetDb)

test('defaults to the postgres store with 30 day retention', async () => {
  expect(await getLoggingSettings()).toEqual({
    store: 'postgres',
    retentionDays: 30,
    payloadMaxBytes: 262144,
  })
})

test('persists a patch and leaves the rest alone', async () => {
  await setLoggingSettings({ store: 'stdout' })
  expect(await getLoggingSettings()).toMatchObject({ store: 'stdout', retentionDays: 30 })

  await setLoggingSettings({ retentionDays: 7 })
  expect(await getLoggingSettings()).toMatchObject({ store: 'stdout', retentionDays: 7 })
})

test('accepts zero retention, which means never prune', async () => {
  await setLoggingSettings({ retentionDays: 0 })
  expect((await getLoggingSettings()).retentionDays).toBe(0)
})

test('rejects a negative retention and a non-positive payload cap', async () => {
  await expect(setLoggingSettings({ retentionDays: -1 })).rejects.toThrow(/retention/i)
  await expect(setLoggingSettings({ payloadMaxBytes: 0 })).rejects.toThrow(/payload/i)
})

test('rejects an empty store name', async () => {
  await expect(setLoggingSettings({ store: '  ' })).rejects.toThrow(/store/i)
})
