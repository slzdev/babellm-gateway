import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

const TABLES = ['route_targets', 'virtual_models', 'api_keys', 'users', 'providers']

export async function resetDb() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )
}

export { db as testDb }
