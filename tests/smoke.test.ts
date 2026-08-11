import { expect, test } from 'vitest'
import { Client } from 'pg'

test('the test database is reachable', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const { rows } = await client.query('SELECT 1 AS ok')
  await client.end()
  expect(rows[0].ok).toBe(1)
})
