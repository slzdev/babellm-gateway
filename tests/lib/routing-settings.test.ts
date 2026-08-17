import { afterEach, beforeEach, expect, test } from 'vitest'
import { getRoutingSettings, setRoutingSettings } from '@/lib/settings'
import { clearRoutingSettingsCache, resolveRoutingSettings } from '@/lib/routing-settings'
import { resetDb } from '../helpers/db'

beforeEach(async () => {
  await resetDb()
  clearRoutingSettingsCache()
})

afterEach(() => {
  clearRoutingSettingsCache()
})

test('an empty settings table yields the spec defaults', async () => {
  expect(await getRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })
})

test('each field can be saved on its own', async () => {
  expect(await setRoutingSettings({ threshold: 2 }))
    .toEqual({ threshold: 2, cooldownSeconds: 30 })
  expect(await setRoutingSettings({ cooldownSeconds: 90 }))
    .toEqual({ threshold: 2, cooldownSeconds: 90 })
})

test('a threshold of 0 is accepted — it disables the breaker', async () => {
  expect(await setRoutingSettings({ threshold: 0 })).toEqual({ threshold: 0, cooldownSeconds: 30 })
})

test('nonsense is rejected rather than stored', async () => {
  await expect(setRoutingSettings({ threshold: -1 })).rejects.toThrow(/threshold/i)
  await expect(setRoutingSettings({ threshold: 1.5 })).rejects.toThrow(/threshold/i)
  await expect(setRoutingSettings({ cooldownSeconds: 0 })).rejects.toThrow(/cooldown/i)
})

test('the cache serves repeat reads and a clear picks up a write', async () => {
  expect(await resolveRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })
  await setRoutingSettings({ threshold: 3 })
  // Still cached — other instances converge within the TTL, which is the
  // documented trade for keeping settings off the failure path.
  expect(await resolveRoutingSettings()).toEqual({ threshold: 5, cooldownSeconds: 30 })

  clearRoutingSettingsCache()
  expect(await resolveRoutingSettings()).toEqual({ threshold: 3, cooldownSeconds: 30 })
})
