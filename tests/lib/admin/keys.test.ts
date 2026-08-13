import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  createApiKey, createUser, deleteApiKey, deleteUser,
  listApiKeys, listUsers, setApiKeyEnabled, setApiKeyLogPayloads,
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

test.each(['abc', '-5', '1e3', '1.1234567'])(
  'rejects a malformed budget: %s',
  async (budget) => {
    await expect(
      createApiKey({ name: 'bad', budgetMonthlyUsd: budget }),
    ).rejects.toThrow(/amount/i)
  },
)

test('rejects an unparseable expiry', async () => {
  await expect(
    createApiKey({ name: 'bad', expiresAt: new Date('not-a-date') }),
  ).rejects.toThrow(/valid date/i)
})

test('accepts a budget at the column precision limit', async () => {
  const { item } = await createApiKey({ name: 'ok', budgetMonthlyUsd: '25.123456' })
  expect(item.budgetMonthlyUsd).toBe('25.123456')
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

test('payload logging is off unless a key opts in at creation', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  expect(item.logPayloads).toBe(false)

  const { item: captured } = await createApiKey({ name: 'captured key', logPayloads: true })
  expect(captured.logPayloads).toBe(true)
})

test('toggling payload logging on a key updates it without touching other fields', async () => {
  const { item } = await createApiKey({ name: 'app key', rpmLimit: 60 })
  await setApiKeyLogPayloads(item.id, true)
  const [updated] = await listApiKeys()
  expect(updated.logPayloads).toBe(true)
  expect(updated.rpmLimit).toBe(60)

  await setApiKeyLogPayloads(item.id, false)
  const [reverted] = await listApiKeys()
  expect(reverted.logPayloads).toBe(false)
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
