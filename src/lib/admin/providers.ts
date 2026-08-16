import 'server-only'
import { asc, count, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  catalogModels, providers, routeTargets, type ProviderRow,
} from '@/lib/db/schema'
import { decryptJson, encryptJson } from '@/lib/crypto'
import { credentialSchemas, maskCredentials, type AdapterType } from '@/lib/adapters/credentials'
import { createAdapter } from '@/lib/adapters/registry'
import { PATH_FIELDS } from '@/lib/adapters/openai/paths'
import { parseProviderConfig, readRegistryNamespace } from '@/lib/catalog/config'

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
  catalogModelCount: number
  registryNamespace: string | null
  /**
   * Only the endpoint paths this provider actually overrides. A key is absent
   * rather than defaulted so the edit form can leave its box empty, which is
   * how the form says "use the default".
   */
  pathOverrides: Record<string, string>
  lastSyncedAt: Date | null
  lastSyncStatus: 'ok' | 'failed' | 'unsupported' | null
  lastSyncError: string | null
  lastSyncSummary: {
    added: number; updated: number; missing: number; total: number; matched?: number
  } | null
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

function readPathOverrides(config: string): Record<string, string> {
  const parsed = parseProviderConfig(config)
  const overrides: Record<string, string> = {}
  for (const field of PATH_FIELDS) {
    const value = parsed[field.name]
    if (typeof value === 'string' && value.length > 0) overrides[field.name] = value
  }
  return overrides
}

export async function listProviders(): Promise<ProviderListItem[]> {
  const rows = await db.select().from(providers).orderBy(asc(providers.name))

  const targetCounts = await db
    .select({ providerId: routeTargets.providerId, count: count() })
    .from(routeTargets)
    .groupBy(routeTargets.providerId)

  const catalogCounts = await db
    .select({ providerId: catalogModels.providerId, count: count() })
    .from(catalogModels)
    .groupBy(catalogModels.providerId)

  const targetsById = new Map(targetCounts.map((r) => [r.providerId, r.count]))
  const catalogById = new Map(catalogCounts.map((r) => [r.providerId, r.count]))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    maskedCredentials: maskCredentials(
      decryptJson<Record<string, unknown>>(row.credentials),
    ),
    targetCount: targetsById.get(row.id) ?? 0,
    catalogModelCount: catalogById.get(row.id) ?? 0,
    registryNamespace: readRegistryNamespace(row.config),
    pathOverrides: readPathOverrides(row.config),
    lastSyncedAt: row.lastSyncedAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    lastSyncSummary: row.lastSyncSummary ?? null,
  }))
}

/**
 * Fetches a provider's config object as stored, so a caller can merge a
 * targeted key into it (e.g. `registryNamespace`) without clobbering other
 * keys — `timeoutMs`, `disableStreamUsage` — that aren't editable from any
 * current form but are still read on the request path.
 */
export async function getProviderConfig(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id))
  if (!row) throw new Error('Provider not found.')
  return parseProviderConfig(row.config)
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

/**
 * bedrock's credential schema is a two-branch union (static keys vs. instance
 * role) rather than one flat shape with optional fields. A field-level merge
 * that blindly overlays new input onto old credentials can silently resurrect
 * the branch an edit is trying to leave: checking "use the instance role"
 * while old access keys are still present via merge lets the static-keys
 * branch keep matching first (zod tries union branches in order), so the
 * checkbox would be silently ignored. When the incoming edit explicitly opts
 * into the instance role, the static-key fields are dropped from the merge
 * base so only the instance-role branch can match. The reverse direction
 * needs no special handling: supplying accessKeyId/secretAccessKey always
 * satisfies the static-keys branch first, and zod's default "strip unknown
 * keys" behavior drops any stale useInstanceRole flag from the parsed result.
 */
function mergeCredentials(
  adapter: AdapterType,
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (adapter === 'bedrock' && patch.useInstanceRole === true) {
    const staticKeyFields = new Set(['accessKeyId', 'secretAccessKey', 'sessionToken'])
    const filteredBase = Object.fromEntries(
      Object.entries(base).filter(([key]) => !staticKeyFields.has(key)),
    )
    return { ...filteredBase, ...patch }
  }
  return { ...base, ...patch }
}

export async function updateProvider(
  id: string,
  input: Partial<ProviderInput>,
): Promise<ProviderRow> {
  const [existing] = await db.select().from(providers).where(eq(providers.id, id))
  if (!existing) throw new Error('Provider not found.')

  const adapter = input.adapter ?? existing.adapter
  const baseUrl = input.baseUrl === undefined ? existing.baseUrl : input.baseUrl
  const adapterChanged = input.adapter !== undefined && input.adapter !== existing.adapter

  let credentials = existing.credentials
  if (input.credentials) {
    // A field left blank in the edit form means "keep this one field", not
    // "erase it" — the browser is never sent the stored secret, so the new
    // input is merged onto what's stored rather than replacing the whole
    // blob. That merge is only sound when the credential shape hasn't
    // changed; switching adapters would merge an old shape into a new one,
    // so that case replaces wholesale instead (an empty merge base).
    const base = adapterChanged
      ? {}
      : decryptJson<Record<string, unknown>>(existing.credentials)
    const merged = mergeCredentials(adapter, base, input.credentials)
    credentials = encryptJson(validate(adapter, merged, baseUrl))
  } else {
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
