import { config } from 'dotenv'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

export default async function setup() {
  config({ path: '.env.test', override: true })
  const url = new URL(process.env.DATABASE_URL!)
  const dbName = url.pathname.slice(1)

  const adminUrl = new URL(url.toString())
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  )
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`)
  await admin.end()

  const pool = new Pool({ connectionString: url.toString() })
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
  await pool.end()
}
