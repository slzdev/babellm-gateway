import 'server-only'
import { eq } from 'drizzle-orm'
import { getCatalogSettings } from '@/lib/settings'
import { db } from '@/lib/db'
import { registryCache } from '@/lib/db/schema'
import type { CatalogFields, Modalities, ModelKind } from './types'

/** Canonical key ("openai/gpt-4o") to the fields we merge. */
export type RegistryIndex = Record<string, CatalogFields>

export const REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 30_000

/** The subset of a models.dev model entry this projection reads. */
export interface ModelsDevModel {
  id?: string
  family?: string
  temperature?: boolean
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * models.dev carries no chat/embedding marker — text-embedding-3-small is
 * identical to a chat model on every field except `family` and a zero output
 * cost. Output modality is the only fully reliable signal, so it goes first.
 */
export function kindFromModelsDev(model: ModelsDevModel): ModelKind {
  const output = model.modalities?.output ?? []
  if (output.includes('image')) return 'image'
  if (output.includes('video')) return 'video'
  if (output.includes('audio')) return 'audio'
  if (/embed/i.test(model.family ?? '')) return 'embedding'
  if (model.cost?.output === 0 && model.temperature === false) return 'embedding'
  return 'chat'
}

/**
 * Reduce the 3.6 MB models.dev document to the ~1.6 MB of fields we merge,
 * keyed by canonical key. Runs before caching, so every sync reads a
 * ready-made lookup table rather than re-walking the raw document. The seed
 * loader uses this same function.
 */
export function projectModelsDev(doc: unknown): RegistryIndex {
  const index: RegistryIndex = {}
  if (!doc || typeof doc !== 'object') return index

  for (const [slug, provider] of Object.entries(doc as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object') continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== 'object') continue

    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const model = raw as ModelsDevModel

      const modalities: Modalities | null = model.modalities
        ? { input: model.modalities.input ?? [], output: model.modalities.output ?? [] }
        : null

      index[`${slug}/${modelId}`] = {
        kind: kindFromModelsDev(model),
        contextWindow: num(model.limit?.context),
        maxOutputTokens: num(model.limit?.output),
        inputPerMtok: num(model.cost?.input),
        outputPerMtok: num(model.cost?.output),
        cachedInputPerMtok: num(model.cost?.cache_read),
        supportsTools: bool(model.tool_call),
        // models.dev does not report streaming support.
        supportsStreaming: null,
        modalities,
      }
    }
  }

  return index
}

export type RegistryStatus = 'fresh' | 'cached' | 'disabled' | 'failed'

export interface RegistryLoad {
  index: RegistryIndex
  status: RegistryStatus
  url: string
  fetchedAt: Date | null
  error: string | null
}

/**
 * Never throws. A registry that cannot be reached degrades to the last good
 * cache, then to an empty index — a sync must still succeed on discovery and
 * seed alone.
 */
export async function loadRegistry(
  opts: { force?: boolean; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<RegistryLoad> {
  const now = opts.now ?? new Date()
  const { registryEnabled, registryUrl } = await getCatalogSettings()

  const [cached] = await db
    .select()
    .from(registryCache)
    .where(eq(registryCache.url, registryUrl))

  if (!registryEnabled) {
    return {
      index: {}, status: 'disabled', url: registryUrl,
      fetchedAt: cached?.fetchedAt ?? null, error: null,
    }
  }

  const cachedIndex = () => (cached!.payload ?? {}) as RegistryIndex
  const age = cached ? now.getTime() - cached.fetchedAt.getTime() : Number.POSITIVE_INFINITY

  if (cached && !opts.force && age < REGISTRY_MAX_AGE_MS) {
    return {
      index: cachedIndex(), status: 'cached', url: registryUrl,
      fetchedAt: cached.fetchedAt, error: null,
    }
  }

  const doFetch = opts.fetchImpl ?? fetch

  try {
    const response = await doFetch(registryUrl, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

    const index = projectModelsDev(await response.json())
    // A structurally valid but empty document would otherwise overwrite a good
    // cache with nothing.
    if (Object.keys(index).length === 0) throw new Error('the document contained no models')

    await db
      .insert(registryCache)
      .values({ url: registryUrl, payload: index, fetchedAt: now })
      .onConflictDoUpdate({
        target: registryCache.url,
        set: { payload: index, fetchedAt: now },
      })

    return { index, status: 'fresh', url: registryUrl, fetchedAt: now, error: null }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'the registry could not be reached'
    if (cached) {
      return {
        index: cachedIndex(), status: 'cached', url: registryUrl,
        fetchedAt: cached.fetchedAt, error,
      }
    }
    return { index: {}, status: 'failed', url: registryUrl, fetchedAt: null, error }
  }
}
