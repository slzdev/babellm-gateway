import { afterEach, beforeEach, expect, test } from 'vitest'
import { getUsageStore, resetUsageStore, usageStoreStatus } from '@/lib/usage/registry'

const original = process.env.REDIS_URL

beforeEach(() => {
  resetUsageStore()
})

afterEach(() => {
  if (original === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = original
  resetUsageStore()
})

test('no REDIS_URL resolves the memory driver', () => {
  delete process.env.REDIS_URL
  expect(getUsageStore().name).toBe('memory')
  expect(usageStoreStatus()).toEqual({ driver: 'memory', healthy: true, error: null })
})

test('REDIS_URL resolves the redis driver', () => {
  // Never connected to; the driver is constructed lazily enough that
  // resolution itself does not need a reachable server.
  process.env.REDIS_URL = 'redis://localhost:6399'
  expect(getUsageStore().name).toBe('redis')
  expect(usageStoreStatus().driver).toBe('redis')
})

test('the store is resolved once and reused', () => {
  delete process.env.REDIS_URL
  expect(getUsageStore()).toBe(getUsageStore())
})

test('an empty REDIS_URL is treated as unset', () => {
  // An empty environment variable is how a compose file spells "not
  // configured"; it must not produce a redis client pointed at nothing.
  process.env.REDIS_URL = ''
  expect(getUsageStore().name).toBe('memory')
})
