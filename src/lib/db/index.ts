import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

declare global {
  var __babellmPool: Pool | undefined
}

const pool =
  globalThis.__babellmPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    // The default (0) waits forever, so a down Postgres hangs every request
    // instead of failing fast.
    connectionTimeoutMillis: 5_000,
  })

if (!globalThis.__babellmPool) {
  // An idle pooled client that errors (Postgres restart, failover,
  // idle_session_timeout, PgBouncer recycle) makes pg-pool emit 'error' on
  // the Pool. Pool extends EventEmitter, so with no listener Node treats
  // that as an unhandled error event and exits the process — taking every
  // in-flight stream with it. Guarded like the pool cache itself so
  // hot-reload doesn't stack listeners.
  pool.on('error', (err) => console.error('[db] idle client error', err))
}

if (process.env.NODE_ENV !== 'production') globalThis.__babellmPool = pool

export const db = drizzle(pool, { schema })
export { pool, schema }
