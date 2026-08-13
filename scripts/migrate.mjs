// Runs pending migrations against DATABASE_URL, then exits.
//
// This is deliberately independent of drizzle-kit (a devDependency, pruned
// from a `--prod` install) so a production image can migrate its own
// database on boot. It uses only `pg` and `drizzle-orm/node-postgres/migrator`,
// both production dependencies — the same migrator tests/setup/global-setup.ts
// already uses against the disposable test database.
//
// Does not load .env files: in production, env vars come from the container
// runtime (docker run -e / --env-file, compose, orchestrator secrets), not a
// checked-in .env. Local development uses `pnpm db:migrate` (drizzle-kit)
// instead.
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

// Drizzle's migrator takes no lock of its own, and it reads which migrations
// are pending *before* opening the transaction that applies them. Two
// containers booting at once therefore both decide to apply the same
// migration, and the loser dies on `duplicate key ... pg_type_typname_nsp_index`
// (or whichever catalog index the first statement touches). Serialising on a
// session advisory lock makes the loser wait, then find nothing pending.
//
// Arbitrary constant; only has to be stable and unique to this migration
// runner across everything that talks to this database.
const LOCK_KEY = 8_314_027_615_442_907n

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.')
  }

  // max: 1 is what makes the advisory lock work: an advisory lock is held by
  // the session that took it, so the lock and the migrations it guards have to
  // run over the same connection.
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 })
  const db = drizzle(pool)
  try {
    await db.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
    try {
      await migrate(db, { migrationsFolder: './drizzle' })
      console.log('[migrate] migrations applied.')
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
    }
  } finally {
    // Also releases the lock if the unlock above never ran: session advisory
    // locks die with the connection.
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
