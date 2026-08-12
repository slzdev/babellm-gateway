import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, users, type UserRow } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'

export interface UserInput {
  name: string
  email?: string | null
  notes?: string | null
}

export interface ApiKeyInput {
  name: string
  userId?: string | null
  rpmLimit?: number | null
  tpmLimit?: number | null
  budgetTotalUsd?: string | null
  budgetMonthlyUsd?: string | null
  expiresAt?: Date | null
  logPayloads?: boolean
}

export interface ApiKeyListItem {
  id: string
  name: string
  keyPrefix: string
  userId: string | null
  userName: string | null
  enabled: boolean
  expiresAt: Date | null
  lastUsedAt: Date | null
  rpmLimit: number | null
  tpmLimit: number | null
  budgetTotalUsd: string | null
  budgetMonthlyUsd: string | null
  logPayloads: boolean
  createdAt: Date
}

export async function listUsers(): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.name))
}

export async function createUser(input: UserInput): Promise<UserRow> {
  const name = input.name.trim()
  if (!name) throw new Error('A user name is required.')
  const [row] = await db.insert(users).values({
    name, email: input.email ?? null, notes: input.notes ?? null,
  }).returning()
  return row
}

export async function deleteUser(id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id))
}

function validateLimit(value: number | null | undefined, label: string) {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const rows = await db
    .select({ key: apiKeys, userName: users.name })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .orderBy(asc(apiKeys.createdAt))

  return rows.map(({ key, userName }) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    userId: key.userId,
    userName: userName ?? null,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    budgetTotalUsd: key.budgetTotalUsd,
    budgetMonthlyUsd: key.budgetMonthlyUsd,
    logPayloads: key.logPayloads,
    createdAt: key.createdAt,
  }))
}

export async function createApiKey(
  input: ApiKeyInput,
): Promise<{ item: ApiKeyListItem; plaintextKey: string }> {
  const name = input.name.trim()
  if (!name) throw new Error('A key name is required.')

  const rpmLimit = validateLimit(input.rpmLimit, 'rpm limit')
  const tpmLimit = validateLimit(input.tpmLimit, 'tpm limit')

  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name,
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    userId: input.userId ?? null,
    rpmLimit,
    tpmLimit,
    budgetTotalUsd: input.budgetTotalUsd ?? null,
    budgetMonthlyUsd: input.budgetMonthlyUsd ?? null,
    expiresAt: input.expiresAt ?? null,
    logPayloads: input.logPayloads ?? false,
  }).returning()

  const userName = row.userId
    ? ((await db.select().from(users).where(eq(users.id, row.userId)))[0]?.name ?? null)
    : null

  return {
    plaintextKey: generated.key,
    item: {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      userId: row.userId,
      userName,
      enabled: row.enabled,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit,
      budgetTotalUsd: row.budgetTotalUsd,
      budgetMonthlyUsd: row.budgetMonthlyUsd,
      logPayloads: row.logPayloads,
      createdAt: row.createdAt,
    },
  }
}

export async function setApiKeyEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(apiKeys).set({ enabled }).where(eq(apiKeys.id, id))
}

export async function deleteApiKey(id: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, id))
}
