import { expect, test } from 'vitest'
import { loadDashboard, parseDashboardFilter } from '@/lib/admin/dashboard'
import { nextDashboardParams } from '@/lib/admin/dashboard-params'
import { writeRollupState } from '@/lib/stats/state'
import { resetDb } from '../../helpers/db'

const NOW = new Date('2026-08-14T13:20:00Z')

test('no params means the default range', () => {
  const { filter, range, grain } = parseDashboardFilter({}, NOW)

  expect(range).toBe('7d')
  expect(filter.to.toISOString()).toBe(NOW.toISOString())
  expect(filter.from.toISOString()).toBe('2026-08-07T13:20:00.000Z')
  expect(grain).toBe('day')
})

test('a 24h range gets an hourly grain', () => {
  expect(parseDashboardFilter({ range: '24h' }, NOW).grain).toBe('hour')
})

test('an unrecognized range degrades to the default rather than throwing', () => {
  // A hand-edited URL should show the default view, not an error page — the
  // same contract parseLogFilter enforces.
  expect(parseDashboardFilter({ range: 'yesterday' }, NOW).range).toBe('7d')
})

test('a non-uuid key is dropped before it can reach a uuid column', () => {
  // eq(usageRollups.apiKeyId, 'nope') is "invalid input syntax for type uuid",
  // an unhandled Postgres error rather than an empty result.
  expect(parseDashboardFilter({ key: 'nope' }, NOW).filter.apiKeyId).toBeUndefined()
  expect(parseDashboardFilter({ user: 'nope' }, NOW).filter.userId).toBeUndefined()
})

test('a valid uuid key is kept', () => {
  const id = '0192f4a1-0000-7000-8000-000000000000'
  expect(parseDashboardFilter({ key: id }, NOW).filter.apiKeyId).toBe(id)
})

test('custom from/to override the range preset', () => {
  const { filter } = parseDashboardFilter({ range: '24h', from: '2026-08-01', to: '2026-08-03' }, NOW)

  expect(filter.from.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  // Inclusive of the whole end day: a user picking 1st to 3rd means through
  // the end of the 3rd, not up to its first instant.
  expect(filter.to.toISOString()).toBe('2026-08-04T00:00:00.000Z')
})

test('a malformed custom date falls back to the preset', () => {
  const { filter } = parseDashboardFilter({ range: '24h', from: 'not-a-date' }, NOW)
  expect(filter.from.toISOString()).toBe('2026-08-13T13:20:00.000Z')
})

test('an inverted custom range falls back rather than querying backwards', () => {
  const { filter } = parseDashboardFilter({ from: '2026-08-10', to: '2026-08-01' }, NOW)
  expect(filter.from.getTime()).toBeLessThan(filter.to.getTime())
})

test('the comparison period is the equal-length window before the range', () => {
  const { previous } = parseDashboardFilter({ range: '24h' }, NOW)

  expect(previous?.to.toISOString()).toBe('2026-08-13T13:20:00.000Z')
  expect(previous?.from.toISOString()).toBe('2026-08-12T13:20:00.000Z')
})

test('all-time has no comparison period', () => {
  // There is no "before all time"; a delta against it would be meaningless.
  expect(parseDashboardFilter({ range: 'all' }, NOW).previous).toBeNull()
})

test('filters carry into the comparison period', () => {
  const id = '0192f4a1-0000-7000-8000-000000000000'
  expect(parseDashboardFilter({ range: '24h', key: id }, NOW).previous?.apiKeyId).toBe(id)
})

test('nextDashboardParams deletes a filter set to its neutral value', () => {
  const current = new URLSearchParams('range=30d&model=gpt-5')

  expect(nextDashboardParams(current, 'model', 'all').toString()).toBe('range=30d')
  expect(nextDashboardParams(current, 'range', '7d').toString()).toBe('model=gpt-5')
})

test('nextDashboardParams clears custom dates when a preset is chosen', () => {
  // Leaving from/to behind would make the preset silently do nothing.
  const current = new URLSearchParams('from=2026-08-01&to=2026-08-03')

  expect(nextDashboardParams(current, 'range', '24h').toString()).toBe('range=24h')
})

test('the backfill banner comes from the rollup state, not from request_logs', async () => {
  // The dashboard reads usage_rollups and nothing else. Measuring the oldest
  // surviving log here would put a query against the largest table in the
  // system back on every page load — the one thing this feature exists to
  // avoid — and the job has already measured it into the state row.
  await resetDb()
  await writeRollupState({
    sealedThrough: NOW,
    backfilledTo: new Date('2026-08-10T00:00:00Z'),
    oldestLog: new Date('2026-08-01T00:00:00Z'),
  }, NOW)

  // request_logs is empty, so a page that consulted it would find no oldest
  // log and drop the banner exactly when it is most needed.
  const view = await loadDashboard(parseDashboardFilter({}, NOW))

  expect(view.error).toBe(false)
  expect(view.backfilledTo?.toISOString()).toBe('2026-08-10T00:00:00.000Z')
})

test('no banner once the backfill has reached the oldest log', async () => {
  await resetDb()
  const oldest = new Date('2026-08-01T00:00:00Z')
  await writeRollupState({ sealedThrough: NOW, backfilledTo: oldest, oldestLog: oldest }, NOW)

  expect((await loadDashboard(parseDashboardFilter({}, NOW))).backfilledTo).toBeNull()
})
