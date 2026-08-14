import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  createApiKey, createUser, deleteApiKey, deleteUser,
  listApiKeys, listUsers, rotateApiKey, setApiKeyEnabled, setApiKeyLogPayloads,
  updateApiKey,
} from '@/lib/admin/keys'
import { hashApiKey, resolveApiKey } from '@/lib/gateway/auth'
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

test('editing a key saves its name, user, limits, budgets, and expiry', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  const user = await createUser({ name: 'Ada' })
  const expiresAt = new Date(Date.now() + 86_400_000)

  await updateApiKey(item.id, {
    name: 'renamed key',
    userId: user.id,
    rpmLimit: 30,
    tpmLimit: 50_000,
    budgetMonthlyUsd: '12.5',
    budgetTotalUsd: '400',
    expiresAt,
    logPayloads: true,
  })

  const [updated] = await listApiKeys()
  expect(updated.name).toBe('renamed key')
  expect(updated.userName).toBe('Ada')
  expect(updated.rpmLimit).toBe(30)
  expect(updated.tpmLimit).toBe(50_000)
  expect(updated.budgetMonthlyUsd).toBe('12.500000')
  expect(updated.budgetTotalUsd).toBe('400.000000')
  expect(updated.expiresAt?.getTime()).toBe(expiresAt.getTime())
  expect(updated.logPayloads).toBe(true)
})

test('editing a key clears the limits left blank', async () => {
  // The edit form posts every field, so an omitted one means "no limit" —
  // not "keep whatever was there".
  const { item } = await createApiKey({
    name: 'limited',
    rpmLimit: 60,
    budgetTotalUsd: '10',
    expiresAt: new Date(Date.now() + 86_400_000),
    logPayloads: true,
  })

  await updateApiKey(item.id, { name: 'limited' })

  const [updated] = await listApiKeys()
  expect(updated.rpmLimit).toBeNull()
  expect(updated.budgetTotalUsd).toBeNull()
  expect(updated.expiresAt).toBeNull()
  expect(updated.logPayloads).toBe(false)
})

test('editing a key leaves its secret alone', async () => {
  const { item, plaintextKey } = await createApiKey({ name: 'app key' })

  await updateApiKey(item.id, { name: 'renamed' })

  const [stored] = await db.select().from(apiKeys)
  expect(stored.keyHash).toBe(hashApiKey(plaintextKey))
  expect(stored.keyPrefix).toBe(item.keyPrefix)
})

test('editing a key rejects a non-positive rate limit', async () => {
  const { item } = await createApiKey({ name: 'app key', rpmLimit: 60 })
  await expect(updateApiKey(item.id, { name: 'app key', rpmLimit: 0 })).rejects.toThrow(/rpm/i)

  const [unchanged] = await listApiKeys()
  expect(unchanged.rpmLimit).toBe(60)
})

test('editing a key rejects a blank name', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  await expect(updateApiKey(item.id, { name: '  ' })).rejects.toThrow(/name/i)
})

test('editing a key that no longer exists reports it', async () => {
  await expect(
    updateApiKey('00000000-0000-0000-0000-000000000000', { name: 'ghost' }),
  ).rejects.toThrow(/not found/i)
})

test('rotating a key issues a new secret and retires the old one', async () => {
  const { item, plaintextKey } = await createApiKey({ name: 'app key' })

  const { plaintextKey: rotated } = await rotateApiKey(item.id)

  expect(rotated).toMatch(/^sk-bab-[A-Za-z0-9_-]{43}$/)
  expect(rotated).not.toBe(plaintextKey)
  await expect(resolveApiKey(plaintextKey)).rejects.toThrow(/incorrect api key/i)
  expect((await resolveApiKey(rotated)).id).toBe(item.id)
})

test('rotating a key keeps its settings and shows the new prefix', async () => {
  const { item } = await createApiKey({ name: 'app key', rpmLimit: 60, budgetTotalUsd: '10' })

  const { plaintextKey: rotated } = await rotateApiKey(item.id)

  const [updated] = await listApiKeys()
  expect(updated.id).toBe(item.id)
  expect(updated.name).toBe('app key')
  expect(updated.rpmLimit).toBe(60)
  expect(updated.budgetTotalUsd).toBe('10.000000')
  expect(updated.keyPrefix).toBe(rotated.slice(0, 12))
})

test('rotating a key that no longer exists reports it', async () => {
  await expect(
    rotateApiKey('00000000-0000-0000-0000-000000000000'),
  ).rejects.toThrow(/not found/i)
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
