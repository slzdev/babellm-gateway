import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers, routeTargets, type ProviderRow } from '@/lib/db/schema'
import { decryptJson, encryptJson } from '@/lib/crypto'
import { credentialSchemas, maskCredentials, type AdapterType } from '@/lib/adapters/credentials'
import { createAdapter } from '@/lib/adapters/registry'

export interface ProviderInput {
  name: string
  adapter: AdapterType
  baseUrl?: string | null
  credentials: Record<string, unknown>
  config?: Record<string, unknown>
  enabled?: boolean
}

export interface ProviderListItem {
  id: string
  name: string
  adapter: AdapterType
  baseUrl: string | null
  enabled: boolean
  maskedCredentials: Record<string, string>
  targetCount: number
}

function validate(adapter: AdapterType, credentials: unknown, baseUrl?: string | null) {
  const result = credentialSchemas[adapter].safeParse(credentials)
  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    )
  }
  if (adapter === 'openai_compatible' && !baseUrl) {
    throw new Error('An openai_compatible provider requires a base URL.')
  }
  return result.data as Record<string, unknown>
}

export async function listProviders(): Promise<ProviderListItem[]> {
  const rows = await db.select().from(providers).orderBy(asc(providers.name))
  const targets = await db.select().from(routeTargets)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    maskedCredentials: maskCredentials(
      decryptJson<Record<string, unknown>>(row.credentials),
    ),
    targetCount: targets.filter((t) => t.providerId === row.id).length,
  }))
}

export async function createProvider(input: ProviderInput): Promise<ProviderRow> {
  const credentials = validate(input.adapter, input.credentials, input.baseUrl)
  const [row] = await db.insert(providers).values({
    name: input.name,
    adapter: input.adapter,
    baseUrl: input.baseUrl ?? null,
    credentials: encryptJson(credentials),
    config: JSON.stringify(input.config ?? {}),
    enabled: input.enabled ?? true,
  }).returning()
  return row
}

export async function updateProvider(
  id: string,
  input: Partial<ProviderInput>,
): Promise<ProviderRow> {
  const [existing] = await db.select().from(providers).where(eq(providers.id, id))
  if (!existing) throw new Error('Provider not found.')

  const adapter = input.adapter ?? existing.adapter
  const baseUrl = input.baseUrl === undefined ? existing.baseUrl : input.baseUrl

  const credentials = input.credentials
    ? encryptJson(validate(adapter, input.credentials, baseUrl))
    : existing.credentials

  if (!input.credentials) {
    validate(adapter, decryptJson<Record<string, unknown>>(existing.credentials), baseUrl)
  }

  const [row] = await db.update(providers).set({
    name: input.name ?? existing.name,
    adapter,
    baseUrl,
    credentials,
    config: input.config ? JSON.stringify(input.config) : existing.config,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: new Date(),
  }).where(eq(providers.id, id)).returning()

  return row
}

export async function deleteProvider(id: string): Promise<void> {
  const referencing = await db
    .select()
    .from(routeTargets)
    .where(eq(routeTargets.providerId, id))

  if (referencing.length > 0) {
    throw new Error(
      `This provider is used by ${referencing.length} route target(s). Remove them first.`,
    )
  }
  await db.delete(providers).where(eq(providers.id, id))
}

export async function testProvider(
  id: string,
  upstreamModel: string,
): Promise<{ ok: boolean; message: string }> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id))
  if (!row) return { ok: false, message: 'Provider not found.' }

  try {
    const adapter = createAdapter(row)
    await adapter.chat(
      { model: upstreamModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      {
        upstreamModel,
        requestId: 'provider-test',
        signal: AbortSignal.timeout(20_000),
      },
    )
    return { ok: true, message: 'Connection succeeded.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed.' }
  }
}
