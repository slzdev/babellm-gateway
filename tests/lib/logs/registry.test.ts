import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as settingsModule from '@/lib/settings'
import { setLoggingSettings } from '@/lib/settings'
import {
  LOG_SETTINGS_TTL_MS, clearRequestLogStoreCache, resolveRequestLogStore,
} from '@/lib/logs/registry'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

test('resolves the postgres store by default', async () => {
  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('postgres')
  expect(resolved.store.readable).toBe(true)
  expect(resolved.fallback).toBeNull()
})

test('resolves the configured store', async () => {
  await setLoggingSettings({ store: 'stdout' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.store.readable).toBe(false)
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

test('an unknown driver name falls back to stdout and says so', async () => {
  await setLoggingSettings({ store: 'clickhouse' })
  clearRequestLogStoreCache()

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.configured).toBe('clickhouse')
  expect(resolved.fallback).toBe('unknown_driver')
})

test('a failed settings read falls back to stdout and caches the fallback', async () => {
  const spy = vi
    .spyOn(settingsModule, 'getLoggingSettings')
    .mockRejectedValue(new Error('connection refused'))

  const resolved = await resolveRequestLogStore()
  expect(resolved.store.name).toBe('stdout')
  expect(resolved.fallback).toBe('settings_error')

  // A database hiccup must not turn the cheapest path in a request into a
  // retry storm.
  await resolveRequestLogStore()
  expect(spy).toHaveBeenCalledTimes(1)
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
