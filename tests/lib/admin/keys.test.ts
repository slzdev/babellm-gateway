import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  createApiKey, createUser, deleteApiKey, deleteUser,
  listApiKeys, listUsers, setApiKeyEnabled,
} from '@/lib/admin/keys'
import { hashApiKey } from '@/lib/gateway/auth'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('creates a user', async () => {
  await createUser({ name: 'Ada Lovelace', email: 'ada@example.com' })
  const users = await listUsers()
  expect(users).toHaveLength(1)
  expect(users[0].name).toBe('Ada Lovelace')
})

test('rejects a blank user name', async () => {
  await expect(createUser({ name: '  ' })).rejects.toThrow(/name/i)
})

test('creates a key, returns the plaintext once, and stores only its hash', async () => {
  const { item, plaintextKey } = await createApiKey({ name: 'app key' })

  expect(plaintextKey).toMatch(/^sk-bab-[A-Za-z0-9_-]{43}$/)
  expect(item.keyPrefix).toBe(plaintextKey.slice(0, 12))
  expect(JSON.stringify(item)).not.toContain(plaintextKey)

  const [stored] = await db.select().from(apiKeys)
  expect(stored.keyHash).toBe(hashApiKey(plaintextKey))
})

test('a listed key never exposes the hash or the plaintext', async () => {
  const { plaintextKey } = await createApiKey({ name: 'app key' })
  const serialized = JSON.stringify(await listApiKeys())
  expect(serialized).not.toContain(plaintextKey)
  expect(serialized).not.toContain(hashApiKey(plaintextKey))
})

test('stores limits, budgets, and expiry', async () => {
  const expiresAt = new Date(Date.now() + 86_400_000)
  await createApiKey({
    name: 'limited',
    rpmLimit: 60,
    tpmLimit: 100_000,
    budgetMonthlyUsd: '25.000000',
    expiresAt,
  })

  const [item] = await listApiKeys()
  expect(item.rpmLimit).toBe(60)
  expect(item.tpmLimit).toBe(100_000)
  expect(item.budgetMonthlyUsd).toBe('25.000000')
  expect(item.expiresAt?.getTime()).toBe(expiresAt.getTime())
})

test('rejects a non-positive rate limit', async () => {
  await expect(createApiKey({ name: 'bad', rpmLimit: 0 })).rejects.toThrow(/rpm/i)
})

test('attributes a key to a user and shows the user name in the listing', async () => {
  const user = await createUser({ name: 'Ada' })
  await createApiKey({ name: 'ada key', userId: user.id })
  const [item] = await listApiKeys()
  expect(item.userName).toBe('Ada')
})

test('revoking a key disables it without deleting it', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  await setApiKeyEnabled(item.id, false)
  const [updated] = await listApiKeys()
  expect(updated.enabled).toBe(false)
})

test('deleting a key removes it', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  await deleteApiKey(item.id)
  expect(await listApiKeys()).toHaveLength(0)
})

test('deleting a user detaches its keys rather than deleting them', async () => {
  const user = await createUser({ name: 'Ada' })
  await createApiKey({ name: 'ada key', userId: user.id })
  await deleteUser(user.id)

  const [item] = await listApiKeys()
  expect(item.userId).toBeNull()
  expect(item.userName).toBeNull()
})
