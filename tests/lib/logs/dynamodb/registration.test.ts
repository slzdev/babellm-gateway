import { expect, test } from 'vitest'
import { DRIVERS } from '@/lib/logs'

test('the driver stays out of the registry when it is not configured', () => {
  // DYNAMODB_LOGS_TABLE is the enable switch, and .env.test deliberately does
  // not set it. An unconfigured driver in DRIVERS would show up in the
  // Settings picker and, worse, be called by runLogMaintenance — which
  // maintains every registered driver, not only the active one.
  expect(process.env.DYNAMODB_LOGS_TABLE).toBeUndefined()
  expect(Object.hasOwn(DRIVERS, 'dynamodb')).toBe(false)
})

test('postgres is always registered', () => {
  expect(DRIVERS.postgres?.name).toBe('postgres')
})
