import { afterEach, beforeEach, expect, test } from 'vitest'
import { targetBreakerViews } from '@/lib/admin/health'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { clearRoutingSettingsCache } from '@/lib/routing-settings'
import { resetDb } from '../../helpers/db'

const target = (id: string, threshold: number | null = null) => ({
  id, breakerThreshold: threshold, breakerCooldownSeconds: null,
})

beforeEach(async () => {
  await resetDb()
  resetHealthStore()
  clearRoutingSettingsCache()
})

afterEach(() => {
  resetHealthStore()
  clearRoutingSettingsCache()
})

test('a target with no history reads closed', async () => {
  const views = await targetBreakerViews([target('a')])
  expect(views.get('a')).toEqual({ state: 'closed', reopensIn: null, lastError: null })
})

test('an open breaker reports how long it has left and why', async () => {
  const store = getHealthStore()
  const config = { threshold: 1, cooldownSeconds: 30 }
  await store.fail('a', config, 'upstream exploded')

  const views = await targetBreakerViews([target('a', 1)])
  expect(views.get('a')?.state).toBe('open')
  expect(views.get('a')?.reopensIn).toBeGreaterThan(0)
  expect(views.get('a')?.lastError).toBe('upstream exploded')
})

test('a per-target threshold decides the reading', async () => {
  const store = getHealthStore()
  // 5 failures crosses the global default threshold (5, unseeded after
  // resetDb) but stays under this target's own override of 10. A
  // resolveBreakerConfig that ignored the override and fell back to the
  // global would read half_open here; only honoring the per-target value
  // reads closed — that divergence is what makes this assertion meaningful.
  for (let i = 0; i < 5; i += 1) {
    await store.fail('a', { threshold: 10, cooldownSeconds: 30 }, 'boom')
  }

  expect((await targetBreakerViews([target('a', 10)])).get('a')?.state).toBe('closed')
})

test('an unreadable store reports every target as closed', async () => {
  const store = getHealthStore()
  store.details = () => Promise.reject(new Error('redis is gone'))

  const views = await targetBreakerViews([target('a')])
  expect(views.get('a')).toEqual({ state: 'closed', reopensIn: null, lastError: null })
})
