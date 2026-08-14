import { postgresStore } from '@/lib/logs/postgres'
import { DRIVERS } from '@/lib/logs/registry'
import type { WriteOnlySink } from '@/lib/logs/types'

/**
 * Polls `check` until it returns true, or throws once `timeoutMs` elapses.
 *
 * The handler deliberately does not await logRequest — a log write is not
 * worth client latency — so a test that asserts on its effect has to wait
 * for it. A fixed sleep is a race against a real database transaction;
 * polling gives every environment exactly the time it needs and fails with a
 * clear message instead of asserting on a write that never landed.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition was not satisfied within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Waits for at least `expected` rows to have landed in the postgres request
 * log store. */
export async function waitForLogs(expected = 1, timeoutMs = 2000): Promise<void> {
  await waitFor(async () => {
    const page = await postgresStore.query({ limit: expected })
    return page.rows.length >= expected
  }, timeoutMs)
}

export const WRITE_ONLY_DRIVER = 'test-write-only'

const writeOnlySink: WriteOnlySink = {
  name: WRITE_ONLY_DRIVER,
  readable: false,
  async write() {},
  async maintain() {
    return { created: [], dropped: [] }
  },
}

/**
 * Registers a write-only driver for the duration of one test and returns the
 * call that unregisters it.
 *
 * Every driver the gateway ships is readable, so the write-only half of the
 * RequestLogStore union — and every state that hangs off it, from the
 * registry's narrowing to the "cannot be read back" panel — would otherwise
 * have nothing exercising it. That is exactly the code a fork adding a
 * write-only sink lands on, so it is kept honest here rather than left to be
 * discovered broken.
 */
export function registerWriteOnlyDriver(): () => void {
  DRIVERS[WRITE_ONLY_DRIVER] = writeOnlySink
  return () => {
    delete DRIVERS[WRITE_ONLY_DRIVER]
  }
}
