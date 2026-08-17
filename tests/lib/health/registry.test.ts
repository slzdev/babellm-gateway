import { afterEach, expect, test } from 'vitest'
import { getHealthStore, healthStoreStatus, resetHealthStore } from '@/lib/health/registry'

afterEach(() => {
  delete process.env.REDIS_URL
  resetHealthStore()
})

test('without REDIS_URL the memory driver is used', () => {
  expect(getHealthStore().name).toBe('memory')
  expect(healthStoreStatus()).toEqual({ driver: 'memory', healthy: true, error: null })
})

test('the store is resolved once and reused', () => {
  expect(getHealthStore()).toBe(getHealthStore())
})

test('REDIS_URL selects the redis driver', () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1'
  expect(getHealthStore().name).toBe('redis')
})

test('a blank REDIS_URL is not a configured one', () => {
  process.env.REDIS_URL = '   '
  expect(getHealthStore().name).toBe('memory')
})
