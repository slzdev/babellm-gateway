import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

const TABLES = [
  'request_payloads', 'request_logs',
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]

export async function resetDb() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )
}

export { db as testDb }
