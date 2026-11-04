import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { decryptJson } from '@/lib/crypto'
import { createProvider } from '@/lib/admin/providers'
import { resetDb } from '../../helpers/db'

// Keep validation, encryption and persistence real. Only Next request context
// and the external catalog discovery triggered after a save are replaced.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/admin/session', () => ({ requireAdmin: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/catalog/sync', () => ({
  syncProvider: vi.fn().mockImplementation(async (providerId: string) => ({
    providerId, providerName: 'bedrock', status: 'ok',
    summary: { added: 0, updated: 0, missing: 0, total: 0, matched: 0 },
    error: null, registryStatus: null, registryError: null,
  })),
}))

const { createProviderAction, updateProviderAction } = await import('@/app/(admin)/providers/actions')

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64)
  vi.clearAllMocks()
  await resetDb()
})

function providerForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

async function savedCredentials(id: string) {
  const [row] = await db.select().from(providers).where(eq(providers.id, id))
  return decryptJson(row.credentials)
}

async function roleProvider() {
  return createProvider({
    name: 'bedrock', adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })
}

test('an unchecked Bedrock edit requires static keys instead of retaining default-chain mode', async () => {
  const created = await roleProvider()
  const result = await updateProviderAction(undefined, providerForm({
    id: created.id, name: 'bedrock', adapter: 'bedrock',
    region: '', accessKeyId: '', secretAccessKey: '', sessionToken: '',
  }))
  expect(result.error).toContain('accessKeyId:')
  expect(result.error).toContain('secretAccessKey:')
  expect(result.success).toBeUndefined()
  expect(await savedCredentials(created.id)).toEqual({ region: 'us-east-1', useInstanceRole: true })
})

test('an unchecked Bedrock edit switches to static keys and carries a session token', async () => {
  const created = await roleProvider()
  const result = await updateProviderAction(undefined, providerForm({
    id: created.id, name: 'bedrock', adapter: 'bedrock',
    accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN',
  }))
  expect(result).toEqual({ success: 'Provider updated.' })
  expect(await savedCredentials(created.id)).toEqual({
    region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN',
  })
})

test('a checked Bedrock edit discards stored static keys and token', async () => {
  const created = await createProvider({
    name: 'bedrock', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN' },
  })
  const result = await updateProviderAction(undefined, providerForm({
    id: created.id, name: 'bedrock', adapter: 'bedrock', useInstanceRole: 'on',
    accessKeyId: '', secretAccessKey: '', sessionToken: '',
  }))
  expect(result).toEqual({ success: 'Provider updated.' })
  expect(await savedCredentials(created.id)).toEqual({ region: 'us-east-1', useInstanceRole: true })
})

test.each(['accessKeyId', 'secretAccessKey', 'sessionToken'])(
  'a checked Bedrock edit rejects a freshly entered %s without changing credentials', async (field) => {
    const created = await roleProvider()
    const result = await updateProviderAction(undefined, providerForm({
      id: created.id, name: 'bedrock', adapter: 'bedrock', useInstanceRole: 'on', [field]: 'fresh-value',
    }))
    expect(result.error).toContain(`${field}:`)
    expect(result.success).toBeUndefined()
    expect(await savedCredentials(created.id)).toEqual({ region: 'us-east-1', useInstanceRole: true })
  },
)

test('blank static fields preserve stored Bedrock credentials while region changes', async () => {
  const created = await createProvider({
    name: 'bedrock', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN' },
  })
  const result = await updateProviderAction(undefined, providerForm({
    id: created.id, name: 'bedrock', adapter: 'bedrock', region: 'eu-west-1',
    accessKeyId: '', secretAccessKey: '', sessionToken: '',
  }))
  expect(result).toEqual({ success: 'Provider updated.' })
  expect(await savedCredentials(created.id)).toEqual({
    region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN',
  })
})

test('creating a Bedrock provider carries its optional session token into encrypted storage', async () => {
  const result = await createProviderAction(undefined, providerForm({
    name: 'bedrock', adapter: 'bedrock', region: 'us-east-1',
    accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'session-token',
  }))
  expect(result).toEqual({ success: 'Provider created.' })
  const [row] = await db.select().from(providers)
  expect(row.credentials).not.toContain('session-token')
  expect(decryptJson(row.credentials)).toEqual({
    region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'session-token',
  })
})

test('a blank OpenAI edit preserves its key and organization', async () => {
  const created = await createProvider({
    name: 'openai', adapter: 'openai', credentials: { apiKey: 'sk-existing', organization: 'org-existing' },
  })
  const result = await updateProviderAction(undefined, providerForm({
    id: created.id, name: 'renamed', adapter: 'openai', apiKey: '', organization: '', project: '',
  }))
  expect(result).toEqual({ success: 'Provider updated.' })
  expect(await savedCredentials(created.id)).toEqual({ apiKey: 'sk-existing', organization: 'org-existing' })
})
