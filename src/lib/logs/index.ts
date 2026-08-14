import 'server-only'
import { resolveRequestLogStore } from './registry'
import type { RequestLogEntry } from './types'

/**
 * Writes one request log entry to whichever store is configured.
 *
 * Callers must not await this on the request path — a log write is not worth
 * a millisecond of client latency. It still rejects rather than swallowing,
 * so the caller's .catch() can report the failure to stderr.
 */
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const { store, settings } = await resolveRequestLogStore()
  await store.write(entry, settings)
}

export {
  DRIVERS, LOG_SETTINGS_TTL_MS, clearRequestLogStoreCache,
  getRequestLogStore, resolveRequestLogStore,
} from './registry'
export type { StoreResolution } from './registry'
export * from './types'
