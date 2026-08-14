import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, users, type UserRow } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'
import { clearUsage } from '@/lib/usage'

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

function validateMoney(value: string | null | undefined, label: string) {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`${label} must be a positive amount with at most 6 decimal places.`)
  }
  return trimmed
}

function validateExpiry(value: Date | null | undefined) {
  if (value === null || value === undefined) return null
  if (Number.isNaN(value.getTime())) {
    throw new Error('Expiry must be a valid date.')
  }
  return value
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  // Select only the columns ApiKeyListItem needs — keyHash never leaves the
  // data layer, so "the hash never leaks" holds by construction rather than
  // depending on every caller remembering to strip it.
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      userId: apiKeys.userId,
      userName: users.name,
      enabled: apiKeys.enabled,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      rpmLimit: apiKeys.rpmLimit,
      tpmLimit: apiKeys.tpmLimit,
      budgetTotalUsd: apiKeys.budgetTotalUsd,
      budgetMonthlyUsd: apiKeys.budgetMonthlyUsd,
      logPayloads: apiKeys.logPayloads,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .orderBy(asc(apiKeys.createdAt))

  return rows.map((row) => ({ ...row, userName: row.userName ?? null }))
}

export async function createApiKey(
  input: ApiKeyInput,
): Promise<{ item: ApiKeyListItem; plaintextKey: string }> {
  const name = input.name.trim()
  if (!name) throw new Error('A key name is required.')

  const rpmLimit = validateLimit(input.rpmLimit, 'rpm limit')
  const tpmLimit = validateLimit(input.tpmLimit, 'tpm limit')
  const budgetTotalUsd = validateMoney(input.budgetTotalUsd, 'Total budget')
  const budgetMonthlyUsd = validateMoney(input.budgetMonthlyUsd, 'Monthly budget')
  const expiresAt = validateExpiry(input.expiresAt)

  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name,
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    userId: input.userId ?? null,
    rpmLimit,
    tpmLimit,
    budgetTotalUsd,
    budgetMonthlyUsd,
    expiresAt,
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

/**
 * Saves an edit to a key's settings.
 *
 * Every field is authoritative: unlike a provider's credentials, none of
 * these are hidden from the browser, so the edit form posts all of them and a
 * blank one means "no limit" rather than "keep what was stored". The secret
 * is not among them — only its hash is here to keep, and replacing it is
 * `rotateApiKey`'s job.
 */
export async function updateApiKey(id: string, input: ApiKeyInput): Promise<void> {
  const name = input.name.trim()
  if (!name) throw new Error('A key name is required.')

  const values = {
    name,
    userId: input.userId ?? null,
    rpmLimit: validateLimit(input.rpmLimit, 'rpm limit'),
    tpmLimit: validateLimit(input.tpmLimit, 'tpm limit'),
    budgetTotalUsd: validateMoney(input.budgetTotalUsd, 'Total budget'),
    budgetMonthlyUsd: validateMoney(input.budgetMonthlyUsd, 'Monthly budget'),
    expiresAt: validateExpiry(input.expiresAt),
    logPayloads: input.logPayloads ?? false,
  }

  const updated = await db.update(apiKeys).set(values).where(eq(apiKeys.id, id)).returning()
  if (updated.length === 0) throw new Error('API key not found.')
}

/**
 * Issues a new secret for an existing key.
 *
 * The row keeps its id, so its limits, budgets and logs all carry over, and
 * its counters keep counting. `resolveApiKey` hashes the presented token on
 * every request with nothing cached in between, so the old secret stops
 * working the moment this commits.
 */
export async function rotateApiKey(id: string): Promise<{ plaintextKey: string }> {
  const generated = generateApiKey()
  const updated = await db
    .update(apiKeys)
    .set({ keyHash: generated.keyHash, keyPrefix: generated.keyPrefix })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id })

  if (updated.length === 0) throw new Error('API key not found.')
  return { plaintextKey: generated.key }
}

/**
 * Zeroes a key's counters, letting a key that hit its total budget — the one
 * counter with no expiry — work again without raising the budget.
 *
 * Returns false if the counter store could not be reached, so the admin is
 * not told the reset happened when it did not.
 */
export async function resetApiKeyUsage(id: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
  if (!existing) throw new Error('API key not found.')

  return clearUsage(id)
}

export async function setApiKeyEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(apiKeys).set({ enabled }).where(eq(apiKeys.id, id))
}

export async function setApiKeyLogPayloads(id: string, logPayloads: boolean): Promise<void> {
  await db.update(apiKeys).set({ logPayloads }).where(eq(apiKeys.id, id))
}

export async function deleteApiKey(id: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, id))
  // After the row is gone, and awaited only far enough to start: a counter
  // store that is down must not be able to fail a deletion.
  void clearUsage(id)
}
