import { buildRequestLog } from './line'
import type { MaintenanceResult, RequestLogEntry, WriteOnlySink } from './types'

/**
 * Writes one line to stdout. Never throws: a request that succeeded must not
 * be turned into a failure by its own logging.
 */
export const stdoutStore: WriteOnlySink = {
  name: 'stdout',
  readable: false,

  async write(entry: RequestLogEntry): Promise<void> {
    try {
      console.log(JSON.stringify(buildRequestLog(entry)))
    } catch (err) {
      // The fallback needs its own guard: stdout and stderr are frequently the
      // same pipe, so whatever just broke console.log has usually broken this
      // too. A request that succeeded must not be failed by its own logging,
      // and that promise is worth more than the diagnostic.
      try {
        console.error(`[gateway] failed to emit request log request_id=${entry.id}`, err)
      } catch {
        // Nowhere left to report to.
      }
    }
  },

  /** stdout has no storage of its own — the log shipper owns retention. */
  async maintain(): Promise<MaintenanceResult> {
    return { created: [], dropped: [] }
  },
}
