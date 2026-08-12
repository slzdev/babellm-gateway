import 'server-only'
import { asc, eq, inArray } from 'drizzle-orm'
import type { AdapterType } from '@/lib/adapters/credentials'
import { createAdapter } from '@/lib/adapters/registry'
import type { ProviderAdapter } from '@/lib/adapters/types'
import { db, pool } from '@/lib/db'
import { catalogModels, providers, type ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { mergeCatalogFields } from './merge'
import { canonicalKeyCandidates } from './normalize'
import { loadRegistry, type RegistryIndex, type RegistryLoad, type RegistryStatus } from './registry'
import { loadSeed } from './seed'
import type { CatalogFields, EffectiveFields, FieldSources } from './types'

/** Discovery gets its own budget: config.timeoutMs is tuned for chat. */
export const DISCOVERY_TIMEOUT_MS = 30_000

export interface SyncSummary {
  added: number
  updated: number
  missing: number
  total: number
}

export interface SyncResult {
  providerId: string
  providerName: string
  status: 'ok' | 'failed' | 'unsupported'
  summary: SyncSummary | null
  error: string | null
  registryStatus: RegistryStatus | null
  registryError: string | null
}

export interface SyncOptions {
  /** Pre-loaded registry, so a run over many providers fetches once. */
  registry?: RegistryLoad
  now?: Date
  /** Injection point for tests. Defaults to the real adapter registry. */
  createAdapterImpl?: (provider: ProviderRow) => ProviderAdapter
}

function statusOf(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

/**
 * An SDK error's class, which is where the identity actually lives: the OpenAI
 * SDK never assigns `name`, so every one of its errors reports the inherited
 * "Error". Read by name rather than by `instanceof` so this module stays free of
 * any one provider's SDK.
 */
function errorNames(err: unknown): string[] {
  if (!(err instanceof Error)) return []
  const ctor = (err.constructor as { name?: unknown } | undefined)?.name
  return [err.name, typeof ctor === 'string' ? ctor : null].filter((n) => n !== null)
}

/**
 * Our own budget running out. AbortSignal.timeout raises a native TimeoutError,
 * but an adapter that forwards the signal into a client usually surfaces that
 * client's abort error instead — for the OpenAI SDK, APIUserAbortError. Sync
 * passes no signal other than the discovery timeout, so an abort here can only
 * be that timeout firing.
 */
const TIMED_OUT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError', 'APIUserAbortError'])

/** The connection, rather than our budget, timed out — possibly much sooner. */
const CONNECT_TIMEOUT_ERROR_NAMES = new Set(['APIConnectionTimeoutError'])

/**
 * Sync classifies its own failures. It deliberately does not use
 * classifyProviderError: that function serves the request path, and the Phase 1
 * handoff asks for a decision on moving classification behind the adapter
 * boundary before Phase 2. Keeping this local leaves that decision free.
 */
export function describeDiscoveryError(err: unknown): string {
  const status = statusOf(err)

  if (status === 401 || status === 403) {
    return `Credentials were rejected (${status}). Check this provider's API key.`
  }
  if (status === 404 || status === 405) {
    return `This endpoint has no model listing API (${status}).`
  }

  const names = errorNames(err)
  if (names.some((name) => CONNECT_TIMEOUT_ERROR_NAMES.has(name))) {
    return 'Discovery timed out connecting to this provider.'
  }
  if (names.some((name) => TIMED_OUT_ERROR_NAMES.has(name))) {
    return `Discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s.`
  }

  return err instanceof Error ? err.message : String(err)
}

function readRegistryNamespace(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { registryNamespace?: unknown }
    return typeof parsed.registryNamespace === 'string' ? parsed.registryNamespace : null
  } catch {
    return null
  }
}

function matchCanonicalKey(
  adapter: AdapterType,
  modelId: string,
  namespace: string | null,
  registry: RegistryIndex,
  seed: RegistryIndex,
): string | null {
  for (const key of canonicalKeyCandidates(adapter, modelId, namespace)) {
    if (registry[key] || seed[key]) return key
  }
  return null
}

/** numeric columns round-trip as strings through pg. */
function money(value: number | null): string | null {
  return value === null ? null : String(value)
}

/** Exported: Task 8 re-runs the same mapping after an override is edited. */
export function effectiveColumns(effective: EffectiveFields, sources: FieldSources) {
  return {
    kind: effective.kind,
    contextWindow: effective.contextWindow,
    maxOutputTokens: effective.maxOutputTokens,
    inputPerMtok: money(effective.inputPerMtok),
    outputPerMtok: money(effective.outputPerMtok),
    cachedInputPerMtok: money(effective.cachedInputPerMtok),
    supportsTools: effective.supportsTools,
    supportsStreaming: effective.supportsStreaming,
    modalities: effective.modalities,
    sources: sources as Record<string, string>,
  }
}

async function recordOutcome(result: SyncResult, now: Date): Promise<SyncResult> {
  await db.update(providers).set({
    lastSyncedAt: now,
    lastSyncStatus: result.status,
    lastSyncError: result.error,
    lastSyncSummary: result.summary,
  }).where(eq(providers.id, result.providerId))

  return result
}

async function runSync(provider: ProviderRow, options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? new Date()
  const base = {
    providerId: provider.id,
    providerName: provider.name,
    registryStatus: null as RegistryStatus | null,
    registryError: null as string | null,
  }

  let adapter: ProviderAdapter
  try {
    adapter = (options.createAdapterImpl ?? createAdapter)(provider)
  } catch (err) {
    // gemini and bedrock have no adapter until Phase 3.
    const unsupported = err instanceof UnsupportedOperationError
    return recordOutcome({
      ...base,
      status: unsupported ? 'unsupported' : 'failed',
      summary: null,
      error: describeDiscoveryError(err),
    }, now)
  }

  if (!adapter.listModels) {
    return recordOutcome({
      ...base,
      status: 'unsupported',
      summary: null,
      error: `The "${provider.adapter}" adapter cannot list models yet.`,
    }, now)
  }

  let discovered
  try {
    discovered = await adapter.listModels({ signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
  } catch (err) {
    // Existing rows are left untouched: a bad sync never degrades the catalog.
    return recordOutcome({
      ...base, status: 'failed', summary: null, error: describeDiscoveryError(err),
    }, now)
  }

  const registry = options.registry ?? (await loadRegistry({ now }))
  const seed = loadSeed()
  const namespace = readRegistryNamespace(provider.config)

  const existing = await db.select().from(catalogModels)
    .where(eq(catalogModels.providerId, provider.id))
  const previousByModelId = new Map(existing.map((row) => [row.modelId, row]))

  const seen = new Set<string>()
  let added = 0
  let updated = 0

  const upserts = discovered.flatMap((model) => {
    // A provider listing the same id twice would otherwise self-conflict.
    if (seen.has(model.id)) return []
    seen.add(model.id)

    const previous = previousByModelId.get(model.id)
    if (previous) updated += 1
    else added += 1

    const canonicalKey = matchCanonicalKey(
      provider.adapter, model.id, namespace, registry.index, seed,
    )
    const registryFields = canonicalKey ? registry.index[canonicalKey] ?? null : null
    const seedFields = canonicalKey ? seed[canonicalKey] ?? null : null

    const { effective, sources } = mergeCatalogFields({
      override: (previous?.override ?? {}) as CatalogFields,
      discovered: model.fields,
      registry: registryFields,
      seed: seedFields,
    }, model.id)

    return [{
      providerId: provider.id,
      modelId: model.id,
      canonicalKey,
      // A hand-added model that shows up in discovery is discovered now. Its
      // override blob rides along untouched: nothing here writes that column.
      origin: 'discovered' as const,
      status: 'available' as const,
      lastSeenAt: now,
      discovered: model.fields as Record<string, unknown>,
      registry: (registryFields ?? {}) as Record<string, unknown>,
      seed: (seedFields ?? {}) as Record<string, unknown>,
      ...effectiveColumns(effective, sources),
      updatedAt: now,
    }]
  })

  const missing = existing.filter(
    (row) => row.origin === 'discovered' && !seen.has(row.modelId),
  )

  await db.transaction(async (tx) => {
    for (const { providerId, modelId, ...set } of upserts) {
      // The conflict target itself is the one thing an update must not rewrite,
      // so `set` is what is left of the row after peeling those two off.
      await tx.insert(catalogModels).values({ providerId, modelId, ...set }).onConflictDoUpdate({
        target: [catalogModels.providerId, catalogModels.modelId],
        set,
      })
    }

    if (missing.length > 0) {
      await tx.update(catalogModels)
        .set({ status: 'missing', updatedAt: now })
        .where(inArray(catalogModels.id, missing.map((row) => row.id)))
    }
  })

  return recordOutcome({
    ...base,
    status: 'ok',
    summary: { added, updated, missing: missing.length, total: upserts.length },
    error: null,
    registryStatus: registry.status,
    registryError: registry.error,
  }, now)
}

/**
 * Sync one provider. The network call happens outside the transaction; every
 * write happens inside one. A Postgres advisory lock — taken on a dedicated
 * connection, because session locks are per-connection — stops two admins
 * double-writing.
 */
export async function syncProvider(
  providerId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId))
  if (!provider) throw new Error('Provider not found.')

  const lockName = `catalog-sync:${providerId}`
  const client = await pool.connect()
  // Set only if the unlock itself fails, in which case this client is destroyed
  // rather than returned to the pool still holding the lock.
  let unlockError: Error | undefined

  try {
    const locked = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockName],
    )
    if (!locked.rows[0]?.ok) {
      return {
        providerId, providerName: provider.name, status: 'failed', summary: null,
        error: 'A sync is already running for this provider.',
        registryStatus: null, registryError: null,
      }
    }

    try {
      return await runSync(provider, options)
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName])
      } catch (err) {
        // The sync itself already finished and its outcome is already recorded
        // on the provider row. Throwing from here would discard that result and,
        // in syncAllProviders, abort every provider after this one — so the
        // failure is logged and carried to release() instead of raised.
        unlockError = err instanceof Error ? err : new Error(String(err))
        console.error(`[catalog] could not release the sync lock for ${lockName}`, err)
      }
    }
  } finally {
    // Passing the error destroys the client instead of recycling one whose
    // session may still hold the lock.
    client.release(unlockError)
  }
}

/** Sync every provider, loading the registry once for the whole run. */
export async function syncAllProviders(options: SyncOptions = {}): Promise<SyncResult[]> {
  const now = options.now ?? new Date()
  const registry = options.registry ?? (await loadRegistry({ now }))
  const rows = await db.select().from(providers).orderBy(asc(providers.name))

  const results: SyncResult[] = []
  for (const row of rows) {
    results.push(await syncProvider(row.id, { ...options, registry, now }))
  }
  return results
}
