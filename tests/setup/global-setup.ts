import { config } from 'dotenv'
import { Client } from 'pg'

export default async function setup() {
  config({ path: '.env.test', override: true })
  const url = new URL(process.env.DATABASE_URL!)
  const dbName = url.pathname.slice(1)

  const adminUrl = new URL(url.toString())
  adminUrl.pathname = '/postgres'
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  const { rowCount } = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  )
  if (!rowCount) await client.query(`CREATE DATABASE "${dbName}"`)
  await client.end()
}
