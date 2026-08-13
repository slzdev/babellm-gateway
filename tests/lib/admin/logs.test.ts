import { beforeEach, expect, test } from 'vitest'
import { LOG_PAGE_SIZE, loadLogs, parseLogFilter } from '@/lib/admin/logs'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { postgresStore } from '@/lib/logs/postgres'
import { setLoggingSettings } from '@/lib/settings'
import { resetDb } from '../../helpers/db'

const NOW = new Date('2026-08-13T12:00:00.000Z')

beforeEach(async () => {
  await resetDb()
  clearRequestLogStoreCache()
})

test('defaults to the last 24 hours and one page', () => {
  const filter = parseLogFilter({}, NOW)
  expect(filter.limit).toBe(LOG_PAGE_SIZE)
  expect(filter.from).toEqual(new Date('2026-08-12T12:00:00.000Z'))
  expect(filter.to).toBeUndefined()
})

test('understands every range option, including all', () => {
  expect(parseLogFilter({ range: '1h' }, NOW).from).toEqual(new Date('2026-08-13T11:00:00.000Z'))
  expect(parseLogFilter({ range: '7d' }, NOW).from).toEqual(new Date('2026-08-06T12:00:00.000Z'))
  expect(parseLogFilter({ range: '30d' }, NOW).from).toEqual(new Date('2026-07-14T12:00:00.000Z'))
  expect(parseLogFilter({ range: 'all' }, NOW).from).toBeUndefined()
})

test('an unrecognized range falls back to the default rather than throwing', () => {
  expect(parseLogFilter({ range: 'nonsense' }, NOW).from)
    .toEqual(new Date('2026-08-12T12:00:00.000Z'))
})

test('maps the single status select onto a class or an outcome', () => {
  expect(parseLogFilter({ status: 'success' }, NOW).statusClass).toBe('success')
  expect(parseLogFilter({ status: 'server_error' }, NOW).statusClass).toBe('server_error')
  expect(parseLogFilter({ status: 'stream_interrupted' }, NOW).outcome).toBe('stream_interrupted')
  expect(parseLogFilter({ status: 'client_closed' }, NOW).outcome).toBe('client_closed')
  expect(parseLogFilter({ status: 'all' }, NOW).statusClass).toBeUndefined()
})

test('passes through key, model and cursors', () => {
  const filter = parseLogFilter(
    { key: 'k-1', model: 'house-model', after: 'cursor-1' },
    NOW,
  )
  expect(filter).toMatchObject({ apiKeyId: 'k-1', model: 'house-model', after: 'cursor-1' })
})

test('drops a blank model rather than filtering on an empty string', () => {
  expect(parseLogFilter({ model: '   ' }, NOW).model).toBeUndefined()
})

test('loadLogs reports a readable store and its page', async () => {
  await postgresStore.write({
    requestId: 'req_x', keyId: null, keyName: null, model: 'm',
    stream: false, status: 200, outcome: 'ok', latencyMs: 1, attempts: [],
  })

  const view = await loadLogs(parseLogFilter({ range: 'all' }))
  expect(view.readable).toBe(true)
  expect(view.storeName).toBe('postgres')
  expect(view.page?.rows).toHaveLength(1)
})

test('loadLogs reports an unreadable store with no page instead of throwing', async () => {
  await setLoggingSettings({ store: 'stdout' })
  clearRequestLogStoreCache()

  const view = await loadLogs(parseLogFilter({}))
  expect(view.readable).toBe(false)
  expect(view.storeName).toBe('stdout')
  expect(view.page).toBeNull()
})

test('loadLogs surfaces an unknown configured driver', async () => {
  await setLoggingSettings({ store: 'clickhouse' })
  clearRequestLogStoreCache()

  const view = await loadLogs(parseLogFilter({}))
  expect(view.fallback).toBe('unknown_driver')
  expect(view.configured).toBe('clickhouse')
})
