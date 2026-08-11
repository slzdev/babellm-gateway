import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

declare global {
  var __babellmPool: Pool | undefined
}

const pool =
  globalThis.__babellmPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 20 })

if (process.env.NODE_ENV !== 'production') globalThis.__babellmPool = pool

export const db = drizzle(pool, { schema })
export { pool, schema }
