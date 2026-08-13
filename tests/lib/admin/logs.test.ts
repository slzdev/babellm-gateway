import { beforeEach, expect, test, vi } from 'vitest'
import { LOG_PAGE_SIZE, loadLogDetail, loadLogs, parseLogFilter } from '@/lib/admin/logs'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { postgresStore } from '@/lib/logs/postgres'
import { setLoggingSettings } from '@/lib/settings'
import { uuidv7 } from '@/lib/uuid'
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
  const id = '01912c3e-1234-7abc-8def-0123456789ab'
  const keyId = '01912c3e-aaaa-7abc-8def-0123456789ab'
  const filter = parseLogFilter(
    { key: keyId, model: 'house-model', after: id },
    NOW,
  )
  expect(filter).toMatchObject({ apiKeyId: keyId, model: 'house-model', after: id })
})

test('drops a malformed key filter rather than passing it to the store', () => {
  // apiKeyId is a uuid column: a non-uuid value must be dropped here, the
  // same as a malformed cursor, rather than reaching
  // eq(requestLogs.apiKeyId, …) and throwing "invalid input syntax for
  // type uuid".
  expect(parseLogFilter({ key: 'not-a-uuid' }, NOW).apiKeyId).toBeUndefined()
})

test('drops a blank model rather than filtering on an empty string', () => {
  expect(parseLogFilter({ model: '   ' }, NOW).model).toBeUndefined()
})

test('drops a malformed after cursor rather than passing it to the store', () => {
  expect(parseLogFilter({ after: 'not-a-uuid' }, NOW).after).toBeUndefined()
})

test('drops a malformed before cursor rather than passing it to the store', () => {
  expect(parseLogFilter({ before: 'also garbage' }, NOW).before).toBeUndefined()
})

test('loadLogs reports a readable store and its page', async () => {
  await postgresStore.write({
    id: uuidv7(), keyId: null, keyName: null, model: 'm',
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

test('loadLogs degrades to an error state rather than crashing when the store fails', async () => {
  // Bypasses parseLogFilter's own validation to reach the store with a
  // filter it cannot satisfy — apiKeyId against a uuid column — producing a
  // genuine database error rather than a mocked one. Spec §9: "query() fails
  // → error state on the page, not a crash."
  const view = await loadLogs({ apiKeyId: 'not-a-uuid', limit: 10 })
  expect(view.error).toBe(true)
  expect(view.readable).toBe(false)
  expect(view.page).toBeNull()
})

test('loadLogs reports no error on the happy path', async () => {
  const view = await loadLogs(parseLogFilter({ range: 'all' }))
  expect(view.error).toBe(false)
})

test('loadLogDetail returns null rather than throwing when the store fails', async () => {
  const spy = vi.spyOn(postgresStore, 'get').mockRejectedValue(new Error('connection reset'))
  try {
    await expect(loadLogDetail('req_x')).resolves.toBeNull()
  } finally {
    spy.mockRestore()
  }
})
