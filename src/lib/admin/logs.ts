import 'server-only'
import { resolveRequestLogStore } from '@/lib/logs'
import type { LogDetail, LogFilter, LogPage, StatusClass } from '@/lib/logs/types'
import { parseTags } from '@/lib/tags'
import { DEFAULT_LOG_PAGE_SIZE, DEFAULT_RANGE, LOG_PAGE_SIZES } from './log-filter-params'

export { DEFAULT_LOG_PAGE_SIZE, DEFAULT_RANGE, LOG_PAGE_SIZES }

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

// apiKeyId is a uuid column too — the same "drop rather than reach the
// store" contract cursor() enforces, since api_keys.id is a uuid and a
// non-uuid `key` would otherwise reach `eq(requestLogs.apiKeyId, …)` and
// throw "invalid input syntax for type uuid".
function key(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined
}

/**
 * Turns repeated `tag` params into a filter object.
 *
 * Shares `parseTags` with the gateway ingress, so a key typed here is
 * normalized exactly as the gateway normalized it on the way in — otherwise a
 * search for `Env=prod` would find nothing while the rows sat there stored as
 * `env`. The two differ only in what a failure means: the gateway throws a
 * 400, and this drops the token, per this module's standing contract that a
 * hand-edited URL shows the default view rather than an error page.
 *
 * Returns undefined when nothing survives, so the caller omits `tags`
 * entirely rather than sending an empty object the store would have to
 * special-case.
 */
function tagFilter(raw: string | string[] | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  const tokens = Array.isArray(raw) ? raw : [raw]

  const tags: Record<string, string> = {}
  for (const token of tokens) {
    const result = parseTags(token)
    if (!result.ok || !result.tags) continue
    for (const [key, value] of Object.entries(result.tags)) {
      // First wins. A duplicated key in a URL is a hand-edit or a stale link,
      // and silently preferring the last one would change which rows come
      // back with no sign in the filter bar.
      if (!Object.hasOwn(tags, key)) tags[key] = value
    }
  }

  return Object.keys(tags).length > 0 ? tags : undefined
}

export interface LogSearchParams {
  range?: string
  key?: string
  model?: string
  status?: string
  /** Repeated `?tag=key=value`. Next supplies an array for a repeated param
   * and a bare string for a single one. */
  tag?: string | string[]
  size?: string
  after?: string
  before?: string
}

// Rows per page comes from the URL, so it is user input reaching a SQL
// LIMIT: only the offered sizes are honoured, and anything else degrades to
// the default rather than letting a hand-edited `?size=1000000` decide how
// much of the store to read.
function pageSize(value: string | undefined): number {
  const size = Number(value)
  return (LOG_PAGE_SIZES as readonly number[]).includes(size)
    ? size
    : DEFAULT_LOG_PAGE_SIZE
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
  const tags = tagFilter(params.tag)

  const apiKeyId = key(params.key)

  return {
    ...(window === null ? {} : { from: new Date(now.getTime() - window) }),
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(model ? { model } : {}),
    ...(status && STATUS_CLASSES.includes(status as StatusClass)
      ? { statusClass: status as StatusClass }
      : {}),
    ...(status === 'stream_interrupted' || status === 'client_closed'
      ? { outcome: status }
      : {}),
    ...(tags ? { tags } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    limit: pageSize(params.size),
  }
}

export interface LogsView {
  readable: boolean
  storeName: string
  configured: string
  fallback: 'unknown_driver' | 'settings_error' | null
  page: LogPage | null
  /** True when resolving the store or querying it threw. Distinct from
   * `readable: false` — that is an expected state (a write-only driver),
   * this is the store failing to answer at all. The page renders it
   * as its own banner rather than the generic Next.js error screen (spec
   * §9: "query() fails → error state on the page, not a crash"). */
  error: boolean
}

export async function loadLogs(filter: LogFilter): Promise<LogsView> {
  try {
    const { store, configured, fallback } = await resolveRequestLogStore()
    // Narrowing on the discriminant, so an unreadable store is a branch here
    // rather than a query() that throws in production.
    const page = store.readable ? await store.query(filter) : null
    return { readable: store.readable, storeName: store.name, configured, fallback, page, error: false }
  } catch (err) {
    console.error('[gateway] could not load request logs', err)
    return { readable: false, storeName: 'unknown', configured: 'unknown', fallback: null, page: null, error: true }
  }
}

export async function loadLogDetail(id: string): Promise<LogDetail | null> {
  try {
    const { store } = await resolveRequestLogStore()
    return store.readable ? await store.get(id) : null
  } catch (err) {
    console.error('[gateway] could not load request log detail', err)
    return null
  }
}
