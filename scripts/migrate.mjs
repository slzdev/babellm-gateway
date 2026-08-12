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
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.')
  }

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 })
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
    console.log('[migrate] migrations applied.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
