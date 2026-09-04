import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  catalogModels, providers, routeTargets,
  type CatalogModelRow,
} from '@/lib/db/schema'
import { readRegistryNamespace } from '@/lib/catalog/config'
import { mergeCatalogFields } from '@/lib/catalog/merge'
import { canonicalKeyCandidates } from '@/lib/catalog/normalize'
import { loadRegistry, type RegistryLoad } from '@/lib/catalog/registry'
import { loadSeed } from '@/lib/catalog/seed'
import { effectiveColumns } from '@/lib/catalog/sync'
import type {
  CatalogFields, FieldSources, Modalities, ModelKind,
} from '@/lib/catalog/types'
import { API_FLAVORS, type ApiFlavor } from '@/lib/api-flavors'
import { parseProviderPath, resolveProviderPaths } from '@/lib/adapters/paths'
import type { ProviderConfig } from '@/lib/adapters/types'
import type { AdapterType } from '@/lib/adapters/credentials'

export interface CatalogListItem {
  id: string
  providerId: string
  providerName: string
  providerAdapter: AdapterType
  modelId: string
  canonicalKey: string | null
  origin: 'discovered' | 'manual'
  status: 'available' | 'missing'
  kind: ModelKind
  contextWindow: number | null
  maxOutputTokens: number | null
  inputPerMtok: number | null
  outputPerMtok: number | null
  cachedInputPerMtok: number | null
  supportsTools: boolean | null
  supportsStreaming: boolean | null
  modalities: Modalities | null
  sources: FieldSources
  override: CatalogFields
  lastSeenAt: Date
  routeTargetCount: number
  apiFlavor: ApiFlavor | null
  chatCompletionsPath: string | null
  responsesPath: string | null
  messagesPath: string | null
  audioTranscriptionsPath: string | null
  embeddingsPath: string | null
  /** What a blank field on this row would inherit, so the dialog can show it
   *  as a placeholder instead of sending an operator to the Providers page. */
  providerApiFlavor: ApiFlavor
  providerPaths: ProviderPathDefaults
}

/** The provider's resolved path for each endpoint a model may override —
 *  keyed like the columns above so the dialog can pair a row's value with the
 *  placeholder it would fall back to. Named rather than written inline at both
 *  of its uses: with five overridable endpoints the second copy is where the
 *  two drift apart. */
interface ProviderPathDefaults {
  chatCompletionsPath: string
  responsesPath: string
  messagesPath: string
  audioTranscriptionsPath: string
  embeddingsPath: string
}

export interface CatalogFilter {
  providerId?: string
  kind?: ModelKind
  status?: 'available' | 'missing'
  search?: string
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value)
}

function toItem(
  row: CatalogModelRow,
  providerName: string,
  providerAdapter: AdapterType,
  providerApiFlavor: ApiFlavor,
  providerPaths: ProviderPathDefaults,
  routeTargetCount: number,
): CatalogListItem {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName,
    providerAdapter,
    modelId: row.modelId,
    canonicalKey: row.canonicalKey,
    origin: row.origin,
    status: row.status,
    kind: row.kind,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    inputPerMtok: toNumber(row.inputPerMtok),
    outputPerMtok: toNumber(row.outputPerMtok),
    cachedInputPerMtok: toNumber(row.cachedInputPerMtok),
    supportsTools: row.supportsTools,
    supportsStreaming: row.supportsStreaming,
    modalities: row.modalities ?? null,
    sources: row.sources as FieldSources,
    override: row.override as CatalogFields,
    lastSeenAt: row.lastSeenAt,
    routeTargetCount,
    apiFlavor: row.apiFlavor,
    chatCompletionsPath: row.chatCompletionsPath,
    responsesPath: row.responsesPath,
    messagesPath: row.messagesPath,
    audioTranscriptionsPath: row.audioTranscriptionsPath,
    embeddingsPath: row.embeddingsPath,
    providerApiFlavor,
    providerPaths,
  }
}

export async function listCatalog(filter: CatalogFilter = {}): Promise<CatalogListItem[]> {
  const conditions = [
    filter.providerId ? eq(catalogModels.providerId, filter.providerId) : undefined,
    filter.kind ? eq(catalogModels.kind, filter.kind) : undefined,
    filter.status ? eq(catalogModels.status, filter.status) : undefined,
  ].filter((c) => c !== undefined)

  const rows = await db
    .select({
      model: catalogModels,
      providerName: providers.name,
      providerAdapter: providers.adapter,
      providerApiFlavor: providers.apiFlavor,
      providerConfig: providers.config,
    })
    .from(catalogModels)
    .innerJoin(providers, eq(catalogModels.providerId, providers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(providers.name), asc(catalogModels.modelId))

  const targets = await db.select().from(routeTargets)
  const search = filter.search?.trim().toLowerCase()

  return rows
    .filter(({ model }) => !search || model.modelId.toLowerCase().includes(search))
    .map(({
      model, providerName, providerAdapter, providerApiFlavor, providerConfig,
    }) => {
      const {
        chatCompletions, responses, messages, audioTranscriptions, embeddings,
      } = resolveProviderPaths(
        JSON.parse(providerConfig) as ProviderConfig,
      )
      return toItem(
        model,
        providerName,
        providerAdapter,
        providerApiFlavor,
        {
          chatCompletionsPath: chatCompletions,
          responsesPath: responses,
          messagesPath: messages,
          audioTranscriptionsPath: audioTranscriptions,
          embeddingsPath: embeddings,
        },
        targets.filter(
          (t) => t.providerId === model.providerId && t.upstreamModel === model.modelId,
        ).length,
      )
    })
}

/** Re-run the merge for one row after its override changed. */
async function remerge(row: CatalogModelRow): Promise<void> {
  const { effective, sources } = mergeCatalogFields({
    override: row.override as CatalogFields,
    discovered: row.discovered as CatalogFields,
    registry: row.registry as CatalogFields,
    seed: row.seed as CatalogFields,
  }, row.modelId)

  await db.update(catalogModels)
    .set({ ...effectiveColumns(effective, sources), updatedAt: new Date() })
    .where(eq(catalogModels.id, row.id))
}

async function requireRow(id: string): Promise<CatalogModelRow> {
  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, id))
  if (!row) throw new Error('Catalog model not found.')
  return row
}

export async function setOverride(id: string, patch: Partial<CatalogFields>): Promise<void> {
  const row = await requireRow(id)
  const override = { ...(row.override as CatalogFields), ...patch }

  const [updated] = await db.update(catalogModels)
    .set({ override: override as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(catalogModels.id, id))
    .returning()

  await remerge(updated)
}

/**
 * Clearing removes the key rather than writing null, so the value falls
 * through to the next layer — "revert to inherited" is a real operation, not a
 * guess at the previous value.
 */
export async function clearOverrideField(
  id: string,
  field: keyof CatalogFields,
): Promise<void> {
  const row = await requireRow(id)
  const override = { ...(row.override as CatalogFields) }
  delete override[field]

  const [updated] = await db.update(catalogModels)
    .set({ override: override as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(catalogModels.id, id))
    .returning()

  await remerge(updated)
}

export interface ManualModelInput {
  providerId: string
  modelId: string
  fields?: CatalogFields
}

export async function addManualModel(
  input: ManualModelInput,
  opts: { registry?: RegistryLoad } = {},
): Promise<CatalogModelRow> {
  const modelId = input.modelId.trim()
  if (!modelId) throw new Error('A model id is required.')

  const [provider] = await db.select().from(providers)
    .where(eq(providers.id, input.providerId))
  if (!provider) throw new Error('Provider not found.')

  const [existing] = await db.select().from(catalogModels).where(
    and(eq(catalogModels.providerId, provider.id), eq(catalogModels.modelId, modelId)),
  )
  if (existing) throw new Error(`"${modelId}" is already in the catalog for this provider.`)

  const registry = opts.registry ?? (await loadRegistry())
  const seed = loadSeed()
  const namespace = readRegistryNamespace(provider.config)

  let canonicalKey: string | null = null
  for (const key of canonicalKeyCandidates(provider.adapter, modelId, namespace)) {
    if (registry.index[key] || seed[key]) {
      canonicalKey = key
      break
    }
  }

  const registryFields = canonicalKey ? registry.index[canonicalKey] ?? null : null
  const seedFields = canonicalKey ? seed[canonicalKey] ?? null : null
  const override = input.fields ?? {}

  const { effective, sources } = mergeCatalogFields({
    override, discovered: null, registry: registryFields, seed: seedFields,
  }, modelId)

  const [row] = await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId,
    canonicalKey,
    origin: 'manual',
    status: 'available',
    // Hand-entered metadata is an override: it must survive a later sync.
    override: override as Record<string, unknown>,
    registry: (registryFields ?? {}) as Record<string, unknown>,
    seed: (seedFields ?? {}) as Record<string, unknown>,
    ...effectiveColumns(effective, sources),
  }).returning()

  return row
}

export async function deleteCatalogModel(id: string): Promise<void> {
  await db.delete(catalogModels).where(eq(catalogModels.id, id))
}

export interface PickerModel {
  id: string
  modelId: string
  kind: ModelKind
  status: 'available' | 'missing'
  contextWindow: number | null
  inputPerMtok: number | null
  outputPerMtok: number | null
}

export interface PickerGroup {
  value: ModelKind
  items: PickerModel[]
}

/** Chat first, unknown last, everything else in between. */
const GROUP_ORDER: readonly ModelKind[] = [
  'chat', 'embedding', 'image', 'audio', 'video', 'unknown',
]

export async function listPickerModels(providerId: string): Promise<PickerGroup[]> {
  const rows = await db.select().from(catalogModels)
    .where(eq(catalogModels.providerId, providerId))
    .orderBy(asc(catalogModels.modelId))

  return GROUP_ORDER.flatMap((kind) => {
    const items = rows.filter((row) => row.kind === kind).map((row) => ({
      id: row.id,
      modelId: row.modelId,
      kind: row.kind,
      status: row.status,
      contextWindow: row.contextWindow,
      inputPerMtok: toNumber(row.inputPerMtok),
      outputPerMtok: toNumber(row.outputPerMtok),
    }))
    return items.length > 0 ? [{ value: kind, items }] : []
  })
}

export type TargetWarning = 'never_synced' | 'not_in_catalog' | 'missing'

/**
 * Warnings for existing route targets, keyed by target id. `never_synced`
 * exists so an upgrade does not greet the admin with a wall of false typos.
 */
export async function targetWarnings(): Promise<Record<string, TargetWarning>> {
  const targets = await db.select().from(routeTargets)
  if (targets.length === 0) return {}

  const providerRows = await db.select().from(providers)
  const catalogRows = await db.select().from(catalogModels)

  const synced = new Set(
    providerRows.filter((p) => p.lastSyncedAt !== null).map((p) => p.id),
  )
  const byKey = new Map(
    catalogRows.map((row) => [`${row.providerId}:${row.modelId}`, row]),
  )

  const warnings: Record<string, TargetWarning> = {}
  for (const target of targets) {
    if (!synced.has(target.providerId)) {
      warnings[target.id] = 'never_synced'
      continue
    }
    const row = byKey.get(`${target.providerId}:${target.upstreamModel}`)
    if (!row) warnings[target.id] = 'not_in_catalog'
    else if (row.status === 'missing') warnings[target.id] = 'missing'
  }

  return warnings
}

export interface ModelGatewayInput {
  apiFlavor?: ApiFlavor | null
  chatCompletionsPath?: string | null
  responsesPath?: string | null
  messagesPath?: string | null
  audioTranscriptionsPath?: string | null
  embeddingsPath?: string | null
}

/**
 * Writes how the gateway reaches one model. A plain column update: these are
 * not layer fields, so there is no re-merge and `override` is left exactly as
 * it was. A blank path clears back to the provider's, which is what the
 * dialog's placeholder promises.
 */
export async function setModelGateway(
  id: string,
  input: ModelGatewayInput,
): Promise<void> {
  await requireRow(id)

  const patch: Record<string, unknown> = { updatedAt: new Date() }

  // `null` is a value here — "inherit the provider" — not an omission. Only
  // `undefined` leaves a field alone.
  if (input.apiFlavor !== undefined) {
    if (input.apiFlavor !== null && !API_FLAVORS.includes(input.apiFlavor)) {
      throw new Error(`"${input.apiFlavor}" is not a supported API flavor.`)
    }
    patch.apiFlavor = input.apiFlavor
  }
  // parseProviderPath returns null for a blank value and throws on a shape
  // that would fail silently upstream, so validation and clearing are the
  // same call — the same one the provider form goes through.
  if (input.chatCompletionsPath !== undefined) {
    patch.chatCompletionsPath = parseProviderPath(input.chatCompletionsPath ?? '')
  }
  if (input.responsesPath !== undefined) {
    patch.responsesPath = parseProviderPath(input.responsesPath ?? '')
  }
  if (input.messagesPath !== undefined) {
    patch.messagesPath = parseProviderPath(input.messagesPath ?? '')
  }
  if (input.audioTranscriptionsPath !== undefined) {
    patch.audioTranscriptionsPath = parseProviderPath(input.audioTranscriptionsPath ?? '')
  }
  if (input.embeddingsPath !== undefined) {
    patch.embeddingsPath = parseProviderPath(input.embeddingsPath ?? '')
  }

  await db.update(catalogModels).set(patch).where(eq(catalogModels.id, id))
}

export interface TargetGatewayView {
  flavor: ApiFlavor
  /** Which row decided it, so the screen can say where to go and change it. */
  source: 'model' | 'provider'
}

/**
 * The effective flavor of every route target, keyed by target id. A sibling of
 * targetWarnings: the virtual-model page configures routing but no longer owns
 * the flavor, and an operator must still be able to see what a target will do.
 */
export async function targetGatewayViews(): Promise<Record<string, TargetGatewayView>> {
  const targets = await db.select().from(routeTargets)
  if (targets.length === 0) return {}

  const providerRows = await db.select().from(providers)
  const catalogRows = await db.select().from(catalogModels)

  const byProvider = new Map(providerRows.map((row) => [row.id, row]))
  const byKey = new Map(
    catalogRows.map((row) => [`${row.providerId}:${row.modelId}`, row]),
  )

  const views: Record<string, TargetGatewayView> = {}
  for (const target of targets) {
    const model = byKey.get(`${target.providerId}:${target.upstreamModel}`)
    if (model?.apiFlavor) {
      views[target.id] = { flavor: model.apiFlavor, source: 'model' }
      continue
    }
    views[target.id] = {
      flavor: byProvider.get(target.providerId)?.apiFlavor ?? 'chat_completions',
      source: 'provider',
    }
  }

  return views
}
