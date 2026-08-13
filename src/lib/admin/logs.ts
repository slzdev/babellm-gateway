import 'server-only'
import { resolveRequestLogStore } from '@/lib/logs'
import type { LogDetail, LogFilter, LogPage, StatusClass } from '@/lib/logs/types'
import { DEFAULT_RANGE } from './log-filter-params'

export { DEFAULT_RANGE }

export const LOG_PAGE_SIZE = 50

const RANGES: Record<string, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  // null means no lower bound at all.
  all: null,
}

const STATUS_CLASSES: StatusClass[] = ['success', 'client_error', 'server_error']

// Keyset cursors are uuid v7 ids passed straight into a Postgres `uuid`
// column comparison. A malformed one must be dropped here rather than
// reaching the store — the same "hand-edited URL shows the default view,
// not an error page" contract that unrecognized ranges already get.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cursor(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined
}

export interface LogSearchParams {
  range?: string
  key?: string
  model?: string
  status?: string
  after?: string
  before?: string
}

/**
 * Turns URL search params into a store filter.
 *
 * Every unrecognized value degrades to the default rather than throwing: a
 * hand-edited URL should show the default view, not an error page.
 */
export function parseLogFilter(
  params: LogSearchParams,
  now: Date = new Date(),
): LogFilter {
  const range = params.range && params.range in RANGES ? params.range : DEFAULT_RANGE
  const window = RANGES[range]
  const model = params.model?.trim()
  const status = params.status
  const after = cursor(params.after)
  const before = cursor(params.before)

  return {
    ...(window === null ? {} : { from: new Date(now.getTime() - window) }),
    ...(params.key ? { apiKeyId: params.key } : {}),
    ...(model ? { model } : {}),
    ...(status && STATUS_CLASSES.includes(status as StatusClass)
      ? { statusClass: status as StatusClass }
      : {}),
    ...(status === 'stream_interrupted' || status === 'client_closed'
      ? { outcome: status }
      : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    limit: LOG_PAGE_SIZE,
  }
}

export interface LogsView {
  readable: boolean
  storeName: string
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  page: LogPage | null
}

export async function loadLogs(filter: LogFilter): Promise<LogsView> {
  const { store, configured, fallback } = await resolveRequestLogStore()
  // Narrowing on the discriminant, so an unreadable store is a branch here
  // rather than a query() that throws in production.
  const page = store.readable ? await store.query(filter) : null
  return { readable: store.readable, storeName: store.name, configured, fallback, page }
}

export async function loadLogDetail(requestId: string): Promise<LogDetail | null> {
  const { store } = await resolveRequestLogStore()
  return store.readable ? store.get(requestId) : null
}
