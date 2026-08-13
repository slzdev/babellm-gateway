/**
 * Runs once per server instance, before it serves anything.
 *
 * The nodejs guard matters: this file is also evaluated for the edge runtime,
 * where setInterval and a database connection are both wrong.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startRetentionTimer } = await import('@/lib/logs/retention')
  startRetentionTimer()
}
