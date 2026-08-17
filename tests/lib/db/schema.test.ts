import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, providers, routeTargets, users, virtualModels } from '@/lib/db/schema'
import { encryptJson, decryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('a provider round-trips with encrypted credentials', async () => {
  const [row] = await db
    .insert(providers)
    .values({
      name: 'openai-prod',
      adapter: 'openai',
      credentials: encryptJson({ apiKey: 'sk-test' }),
    })
    .returning()

  expect(row.enabled).toBe(true)
  expect(row.credentials).not.toContain('sk-test')
  expect(decryptJson<{ apiKey: string }>(row.credentials).apiKey).toBe('sk-test')
})

test('provider names are unique', async () => {
  await db.insert(providers).values({
    name: 'dupe', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  })
  await expect(
    db.insert(providers).values({
      name: 'dupe', adapter: 'openai', credentials: encryptJson({ apiKey: 'b' }),
    }),
  ).rejects.toThrow()
})

test('a route target joins a virtual model to a provider', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()

  await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o-mini',
    priority: 0,
    weight: 100,
  })

  const rows = await db.select().from(routeTargets).where(eq(routeTargets.virtualModelId, model.id))
  expect(rows).toHaveLength(1)
  expect(rows[0].upstreamModel).toBe('gpt-4o-mini')
  expect(model.policy).toBe('failover')
  expect(model.maxAttempts).toBe(3)
})

test('deleting a virtual model cascades to its targets', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mini',
  })

  await db.delete(virtualModels).where(eq(virtualModels.id, model.id))
  expect(await db.select().from(routeTargets)).toHaveLength(0)
})

test('deleting a provider referenced by a route target is rejected', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mini',
  })

  await expect(
    db.delete(providers).where(eq(providers.id, provider.id)),
  ).rejects.toThrow()

  expect(await db.select().from(providers)).toHaveLength(1)
})

test('an api key can exist without a user, and key_hash is unique', async () => {
  await db.insert(apiKeys).values({ name: 'k1', keyHash: 'h1', keyPrefix: 'sk-bab-aaaa' })
  await expect(
    db.insert(apiKeys).values({ name: 'k2', keyHash: 'h1', keyPrefix: 'sk-bab-bbbb' }),
  ).rejects.toThrow()
})

test('deleting a user leaves its keys with a null user_id', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  await db.insert(apiKeys).values({
    name: 'k', keyHash: 'h', keyPrefix: 'sk-bab-cccc', userId: user.id,
  })
  await db.delete(users).where(eq(users.id, user.id))
  const [key] = await db.select().from(apiKeys)
  expect(key.userId).toBeNull()
})

// api_flavor is retired: nothing reads or writes it, and it survives only so a
// deployment still running the previous release keeps a column it inserts
// into. This asserts it is still there with its default — the guard against a
// generated migration quietly dropping it before that release is gone.
test('the retired api_flavor column still exists and defaults', async () => {
  const [row] = await db.insert(providers).values({
    name: 'legacy', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()

  expect(row.apiFlavor).toBe('chat_completions')
})

test('route targets carry nullable breaker overrides', async () => {
  const [p] = await db.insert(providers).values({
    name: 'breaker-p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'breaker-model' }).returning()
  const [row] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'm-1',
  }).returning()

  // NULL is the inherit signal, so the columns must have no default.
  expect(row.breakerThreshold).toBeNull()
  expect(row.breakerCooldownSeconds).toBeNull()

  await db.update(routeTargets)
    .set({ breakerThreshold: 0, breakerCooldownSeconds: 5 })
    .where(eq(routeTargets.id, row.id))
  const [updated] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))

  // 0 is a real value — "never open this target" — not an absent one.
  expect(updated.breakerThreshold).toBe(0)
  expect(updated.breakerCooldownSeconds).toBe(5)
})
