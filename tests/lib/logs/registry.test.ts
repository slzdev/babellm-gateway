import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as settingsModule from '@/lib/settings'
import { setLoggingSettings, type LoggingSettings } from '@/lib/settings'
import {
  LOG_SETTINGS_TTL_MS, clearRequestLogStoreCache, resolveRequestLogStore,
} from '@/lib/logs/registry'
import { WRITE_ONLY_DRIVER, registerWriteOnlyDriver } from '../../helpers/logs'
import { resetDb } from '../../helpers/db'

let unregister: (() => void) | null = null

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  unregister?.()
  unregister = null
})

test('resolves the postgres store by default', async () => {
  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.store.readable).toBe(true)
  expect(resolved.fallback).toBeNull()
})

test('resolves a configured store other than the default, write-only included', async () => {
  unregister = registerWriteOnlyDriver()
  await setLoggingSettings({ store: WRITE_ONLY_DRIVER })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe(WRITE_ONLY_DRIVER)
  expect(resolved.store.readable).toBe(false)
  expect(resolved.fallback).toBeNull()
})

test('serves from cache instead of querying again', async () => {
  const spy = vi.spyOn(settingsModule, 'getLoggingSettings')
  await resolveRequestLogStore()
  await resolveRequestLogStore()
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(1)
})

test('re-reads once the ttl expires', async () => {
  vi.useFakeTimers()
  const spy = vi.spyOn(settingsModule, 'getLoggingSettings')

  await resolveRequestLogStore()
  vi.advanceTimersByTime(LOG_SETTINGS_TTL_MS + 1)
  await resolveRequestLogStore()

  expect(spy).toHaveBeenCalledTimes(2)
})

test('an unknown driver name falls back to the default store and says so', async () => {
  await setLoggingSettings({ store: 'clickhouse' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.configured).toBe('clickhouse')
  expect(resolved.fallback).toBe('unknown_driver')
})

test('a driver name that collides with Object.prototype falls back to the default store, not the prototype value', async () => {
  // DRIVERS is a plain object literal, so a bare `DRIVERS[name]` lookup
  // resolves "constructor" to the `Object` function via the prototype
  // chain instead of `undefined`.
  await setLoggingSettings({ store: 'constructor' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.configured).toBe('constructor')
  expect(resolved.fallback).toBe('unknown_driver')
})

test('a failed settings read falls back to the default store and caches the fallback', async () => {
  const spy = vi
    .spyOn(settingsModule, 'getLoggingSettings')
    .mockRejectedValue(new Error('connection refused'))

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.fallback).toBe('settings_error')

  // A database hiccup must not turn the cheapest path in a request into a
  // retry storm.
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(1)
})

test('a failed settings read resolves retentionMonths to 0, never a guessed default', async () => {
  // A guessed retention is harmless for provisioning but not for deletion:
  // maintenance.ts trusts this value to decide what to drop, and the
  // DynamoDB driver stamps it into every item's TTL at write time — a value
  // written during an outage is permanent there, since that driver's
  // retention is explicitly non-retroactive. 0 means "keep forever" to both,
  // so a guess must never be anything else.
  vi.spyOn(settingsModule, 'getLoggingSettings').mockRejectedValue(new Error('connection refused'))

  const resolved = await resolveRequestLogStore()
  expect(resolved.fallback).toBe('settings_error')
  expect(resolved.settings.retentionMonths).toBe(0)
})

test('concurrent callers on a cold cache share one resolution', async () => {
  const spy = vi.spyOn(settingsModule, 'getLoggingSettings')

  const [a, b, c] = await Promise.all([
    resolveRequestLogStore(), resolveRequestLogStore(), resolveRequestLogStore(),
  ])

  expect(spy).toHaveBeenCalledTimes(1)
  expect(a).toEqual(b)
  expect(a).toEqual(c)
})

test('concurrent callers during a failing settings read share one fallback', async () => {
  const spy = vi
    .spyOn(settingsModule, 'getLoggingSettings')
    .mockRejectedValue(new Error('connection refused'))

  const [a, b] = await Promise.all([resolveRequestLogStore(), resolveRequestLogStore()])

  expect(spy).toHaveBeenCalledTimes(1)
  expect(a.fallback).toBe('settings_error')
  expect(a).toEqual(b)
})

test('a resolution in flight when the cache is cleared does not repopulate it', async () => {
  // A settings write (e.g. the admin Settings page) can call
  // clearRequestLogStoreCache() while an earlier resolveRequestLogStore() is
  // still awaiting the pre-write settings read. That resolution must not
  // silently republish stale state once it finally settles.
  let resolveSettings: (value: LoggingSettings) => void = () => {}
  const staleSettings: LoggingSettings = { store: 'postgres', retentionMonths: 3, payloadMaxBytes: 262_144 }
  const spy = vi
    .spyOn(settingsModule, 'getLoggingSettings')
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSettings = resolve }))

  const pending = resolveRequestLogStore()
  clearRequestLogStoreCache()
  resolveSettings(staleSettings)
  await pending

  // The cache was not repopulated by the stale resolution, so this call
  // re-reads settings instead of being served the pre-write value.
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(2)
})
