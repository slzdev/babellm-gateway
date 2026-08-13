import { postgresStore } from '@/lib/logs/postgres'

/**
 * Polls `check` until it returns true, or throws once `timeoutMs` elapses.
 *
 * The handler deliberately does not await logRequest — a log write is not
 * worth client latency — so a test that asserts on its effect has to wait
 * for it. A fixed sleep is a race against a real database transaction (or,
 * for the stdout driver, a real event-loop turn); polling gives every
 * environment exactly the time it needs and fails with a clear message
 * instead of asserting on a write that never landed.
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
