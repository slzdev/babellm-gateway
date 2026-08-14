/**
 * Runs once per server instance, before it serves anything.
 *
 * The nodejs guard matters: this file is also evaluated for the edge runtime,
 * where setInterval and a database connection are both wrong.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { startPartitionMaintenance } = await import('@/lib/logs/maintenance')
  await startPartitionMaintenance()

  // After partition maintenance, not before: a fresh database has no
  // partitions until that call returns, and a rollup reading request_logs
  // before they exist would be aggregating a table that cannot yet be
  // written to.
  //
  // It schedules the job and returns; the first tick runs in the background.
  // Nothing here waits for a reporting job to catch up before serving.
  const { startUsageRollup } = await import('@/lib/stats/rollup')
  startUsageRollup()
}
