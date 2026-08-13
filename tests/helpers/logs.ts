/**
 * Waits for a fire-and-forget log write to settle.
 *
 * The handler deliberately does not await logRequest — a log write is not
 * worth client latency — so a test that asserts on the row has to give the
 * write a turn of the event loop.
 */
export async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
