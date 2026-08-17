import { expect, test } from 'vitest'
import { breakerState, resolveBreakerConfig } from '@/lib/health/breaker'
import { failTtlSeconds, truncateError } from '@/lib/health/keys'
import { CLOSED, type TargetHealth } from '@/lib/health/types'

const health = (patch: Partial<TargetHealth> = {}): TargetHealth => ({ ...CLOSED, ...patch })
const config = { threshold: 5, cooldownSeconds: 30 }

test('a target with no keys reads closed', () => {
  expect(breakerState(CLOSED, config)).toBe('closed')
})

test('an open marker reads open regardless of the counter', () => {
  expect(breakerState(health({ open: true, reopensIn: 12, consecutiveFailures: 5 }), config))
    .toBe('open')
})

test('failures below the threshold still read closed', () => {
  expect(breakerState(health({ consecutiveFailures: 4 }), config)).toBe('closed')
})

test('a loaded counter with no marker is the half-open probation window', () => {
  // The marker expired but the counter outlived it — the target is back in
  // the chain, and one more failure re-opens it.
  expect(breakerState(health({ consecutiveFailures: 5 }), config)).toBe('half_open')
})

test('a disabled breaker never reads anything but closed', () => {
  expect(breakerState(health({ consecutiveFailures: 99 }), { threshold: 0, cooldownSeconds: 30 }))
    .toBe('closed')
})

test('a live open marker outranks a threshold dropped to 0', () => {
  // Disabling the breaker must not hide a target that is already open — the
  // dashboard, the reset control, and the store all need to keep seeing it.
  expect(breakerState(health({ open: true, reopensIn: 12, consecutiveFailures: 5 }), {
    threshold: 0,
    cooldownSeconds: 30,
  })).toBe('open')
})

test('overrides apply per field, so one can be set and the other inherited', () => {
  expect(resolveBreakerConfig({ breakerThreshold: 2, breakerCooldownSeconds: null }, config))
    .toEqual({ threshold: 2, cooldownSeconds: 30 })
  expect(resolveBreakerConfig({ breakerThreshold: null, breakerCooldownSeconds: 5 }, config))
    .toEqual({ threshold: 5, cooldownSeconds: 5 })
})

test('a per-target threshold of 0 disables the breaker for that target alone', () => {
  expect(resolveBreakerConfig({ breakerThreshold: 0, breakerCooldownSeconds: null }, config))
    .toEqual({ threshold: 0, cooldownSeconds: 30 })
})

test('the failure counter always outlives the open marker', () => {
  // This is what makes half-open free, so it is pinned rather than assumed.
  for (const cooldown of [1, 5, 30, 300, 3600]) {
    expect(failTtlSeconds(cooldown)).toBeGreaterThan(cooldown)
  }
  expect(failTtlSeconds(30)).toBe(60)
  expect(failTtlSeconds(300)).toBe(600)
})

test('error messages are capped so the meta hash stays small', () => {
  expect(truncateError('x'.repeat(500))).toHaveLength(300)
  expect(truncateError('short')).toBe('short')
})
