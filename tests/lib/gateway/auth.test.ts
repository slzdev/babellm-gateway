import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  extractBearerToken, generateApiKey, hashApiKey, resolveApiKey, touchApiKey,
} from '@/lib/gateway/auth'
import { GatewayError } from '@/lib/gateway/errors'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

async function insertKey(overrides: Record<string, unknown> = {}) {
  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    ...overrides,
  }).returning()
  return { ...generated, row }
}

test('generated keys are prefixed, unique, and hashed deterministically', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  expect(a.key).toMatch(/^sk-bab-[A-Za-z0-9_-]{43}$/)
  expect(a.key).not.toBe(b.key)
  expect(a.keyPrefix).toBe(a.key.slice(0, 12))
  expect(a.keyHash).toBe(hashApiKey(a.key))
  expect(a.keyHash).not.toContain(a.key)
})

test('extractBearerToken reads the Authorization header', () => {
  const request = new Request('http://x/v1/chat/completions', {
    headers: { authorization: 'Bearer sk-bab-abc' },
  })
  expect(extractBearerToken(request)).toBe('sk-bab-abc')
})

test('extractBearerToken is case-insensitive on the scheme and returns null when absent', () => {
  expect(
    extractBearerToken(new Request('http://x', { headers: { authorization: 'bearer tok' } })),
  ).toBe('tok')
  expect(extractBearerToken(new Request('http://x'))).toBeNull()
  expect(
    extractBearerToken(new Request('http://x', { headers: { authorization: 'Basic tok' } })),
  ).toBeNull()
})

test('resolveApiKey returns the row for a valid key', async () => {
  const { key, row } = await insertKey()
  expect((await resolveApiKey(key)).id).toBe(row.id)
})

test('resolveApiKey rejects a missing token', async () => {
  await expect(resolveApiKey(null)).rejects.toThrow(GatewayError)
})

test('resolveApiKey rejects an unknown key with 401', async () => {
  await expect(resolveApiKey('sk-bab-nope')).rejects.toMatchObject({ status: 401 })
})

test('resolveApiKey rejects a disabled key', async () => {
  const { key } = await insertKey({ enabled: false })
  await expect(resolveApiKey(key)).rejects.toMatchObject({
    status: 401, code: 'key_disabled',
  })
})

test('resolveApiKey rejects an expired key', async () => {
  const { key } = await insertKey({ expiresAt: new Date(Date.now() - 1000) })
  await expect(resolveApiKey(key)).rejects.toMatchObject({
    status: 401, code: 'key_expired',
  })
})

test('resolveApiKey accepts a key whose expiry is in the future', async () => {
  const { key } = await insertKey({ expiresAt: new Date(Date.now() + 60_000) })
  await expect(resolveApiKey(key)).resolves.toBeDefined()
})

test('touchApiKey records last_used_at', async () => {
  const { row } = await insertKey()
  expect(row.lastUsedAt).toBeNull()
  await touchApiKey(row.id)
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, row.id))
  expect(updated.lastUsedAt).toBeInstanceOf(Date)
})
