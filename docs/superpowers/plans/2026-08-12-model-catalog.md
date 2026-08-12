# Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-provider model catalog, populated by auto-discovery and enriched from models.dev, a vendored snapshot and admin overrides, so route targets get a real model picker instead of a free-text box.

**Architecture:** One row per (provider, model id) in `catalog_models`. Each row stores four raw metadata layers as jsonb — `override`, `discovered`, `registry`, `seed` — plus denormalized effective columns written by a pure `merge()` that resolves them field by field, first non-null wins. The catalog is advisory: `route_targets.upstream_model` stays free text and the gateway request path never reads the catalog.

**Tech Stack:** Next.js 16.3.0 (App Router) · React 19.2.8 · TypeScript · Drizzle ORM 0.45.2 + `pg` · PostgreSQL · Tailwind v4 + shadcn/ui · `@base-ui/react` 1.7.0 · zod 4.4.3 · vitest 4.1.10 · pnpm 10.33.0

**Spec:** `docs/superpowers/specs/2026-08-12-model-catalog-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing any Next.js-specific code.** This Next version has breaking changes from training data (see `AGENTS.md`). The same applies to `node_modules/@base-ui/react/docs/react/components/autocomplete.md` for Task 11.
- **Pin new dependencies exactly** — no caret ranges. No new runtime dependencies are needed by this plan.
- **Every module that touches the database or credentials starts with `import 'server-only'`.**
- **Secrets never reach the browser.** No catalog column may hold a credential.
- **Tests:** `pnpm test` (vitest, serialized file execution against one real Postgres). DB-backed tests call `resetDb()` from `tests/helpers/db.ts` in `beforeEach`.
- **Verification before any completion claim:** `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build` must all pass before the final task is called done. **Every individual task runs at minimum `pnpm test` AND `pnpm exec tsc --noEmit`** — vitest transpiles without type-checking, so a task can be fully green on tests while leaving the branch uncompilable. Task 2 did exactly that and it survived two reviews before Task 4 caught it.
- **Commit after every task**, with the test and implementation files in the same commit.
- **The catalog is advisory.** No task may add a foreign key from `route_targets` to `catalog_models`, and no task may make the gateway request path read the catalog.
- **Layering (carried from the Phase 1 plan):** the gateway never imports from the dashboard. The reverse is permitted — the dashboard may import gateway primitives. No dashboard code (React, session handling, Server Actions) may be reachable from the streaming path. `src/lib/settings.ts` sits outside `lib/admin` precisely so `lib/catalog` can read it without depending on the dashboard's data layer.
- **models.dev facts established by inspecting the live document** (2026-08-12): 183 provider namespaces, 6280 models, 3.6 MB raw / 1.58 MB projected. Shape is `{ [slug]: { id, name, models: { [modelId]: { id, family, temperature, tool_call, modalities: {input[], output[]}, limit: {context, output}, cost: {input, output, cache_read} } } } }`. There is **no** chat/embedding marker field.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/catalog/types.ts` | Shared catalog types. No logic. |
| `src/lib/catalog/merge.ts` | Pure layer merge + kind heuristic. No I/O. |
| `src/lib/catalog/normalize.ts` | Pure canonical-key candidate derivation per adapter. No I/O. |
| `src/lib/catalog/registry.ts` | models.dev projection, fetch, DB cache. |
| `src/lib/catalog/seed.ts` | Loads the vendored snapshot through the registry projection. |
| `src/lib/catalog/seed/models.json` | Vendored, generated. Do not hand-edit. |
| `src/lib/catalog/sync.ts` | Sync orchestration, advisory locking, bookkeeping. |
| `src/lib/settings.ts` | Typed read/write over the `settings` key-value table. |
| `src/lib/admin/catalog.ts` | Catalog queries, overrides, manual rows, for the UI. |
| `scripts/refresh-seed.mjs` | Regenerates the vendored snapshot. |
| `src/app/(admin)/catalog/*` | Catalog page, actions, client components. |

**Modified:** `src/lib/db/schema.ts`, `src/lib/adapters/types.ts`, `src/lib/adapters/openai/index.ts`, `src/lib/admin/models.ts`, `src/app/(admin)/layout.tsx`, `src/app/(admin)/providers/*`, `src/app/(admin)/models/*`, `tests/helpers/db.ts`, `README.md`, and the spec.

`merge.ts` and `normalize.ts` are pure and carry the bulk of the tests. `sync.ts` is the only module needing a provider double.

---

### Task 1: Schema, migration, and spec corrections

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `tests/helpers/db.ts:4`
- Modify: `docs/superpowers/specs/2026-08-12-model-catalog-design.md`
- Create: `drizzle/0001_<generated>.sql` (produced by `pnpm db:generate`)
- Test: `tests/lib/db/catalog-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `catalogModels`, `registryCache`, `settings` tables and `CatalogModelRow`, `RegistryCacheRow`, `SettingRow` types from `@/lib/db/schema`; new `providers` columns `lastSyncedAt`, `lastSyncStatus`, `lastSyncError`, `lastSyncSummary`.

- [ ] **Step 1: Correct the spec before implementing against it**

Three corrections found by inspecting the live models.dev document. Apply them to `docs/superpowers/specs/2026-08-12-model-catalog-design.md`:

1. In the `normalize()` table, replace the `bedrock` row. models.dev stores Bedrock ids **verbatim including region prefix and `-v1:0` suffix** (`us.deepseek.r1-v1:0`, `eu.anthropic.claude-opus-4-5-20251101-v1:0`). New text: `id as-is → region prefix (us./eu./apac./global.) stripped → each known region prefix added`.
2. Add a sentence under `normalize()`: "Canonical keys are namespaced by the models.dev provider slug — `openai/gpt-4o`, `amazon-bedrock/us.deepseek.r1-v1:0`, `google/gemini-flash-latest`. An `openai_compatible` provider with no `registryNamespace` configured produces no candidates and stays unmatched, which is correct: the namespace cannot be guessed. Note that `ollama` has no models.dev namespace at all."
3. In §4 and §5, change the `kind` enum to `chat | embedding | image | audio | video | unknown`. models.dev carries video-output models, and collapsing them into another kind would be wrong. Add: "models.dev has no chat/embedding marker; `kind` is derived from output modalities, then `family` matching `/embed/i`, then `cost.output === 0 && temperature === false`."

- [ ] **Step 2: Write the failing test**

Create `tests/lib/db/catalog-schema.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, registryCache, settings } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

async function makeProvider(name = 'openai-prod') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()
  return row
}

test('a catalog row defaults to discovered and available', async () => {
  const provider = await makeProvider()
  const [row] = await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
  }).returning()

  expect(row.origin).toBe('discovered')
  expect(row.status).toBe('available')
  expect(row.kind).toBe('unknown')
  expect(row.canonicalKey).toBeNull()
  expect(row.override).toEqual({})
  expect(row.sources).toEqual({})
})

test('a model id is unique per provider but not across providers', async () => {
  const a = await makeProvider('a')
  const b = await makeProvider('b')

  await db.insert(catalogModels).values({ providerId: a.id, modelId: 'gpt-4o' })
  await db.insert(catalogModels).values({ providerId: b.id, modelId: 'gpt-4o' })

  await expect(
    db.insert(catalogModels).values({ providerId: a.id, modelId: 'gpt-4o' }),
  ).rejects.toThrow()
})

test('deleting a provider cascades to its catalog rows', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-4o' })

  await db.delete(providers).where(eq(providers.id, provider.id))
  expect(await db.select().from(catalogModels)).toHaveLength(0)
})

test('layer blobs and effective columns round-trip', async () => {
  const provider = await makeProvider()
  const [row] = await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId: 'gpt-4o',
    canonicalKey: 'openai/gpt-4o',
    registry: { contextWindow: 128000, inputPerMtok: 2.5 },
    override: { contextWindow: 64000 },
    kind: 'chat',
    contextWindow: 64000,
    inputPerMtok: '2.5',
    modalities: { input: ['text', 'image'], output: ['text'] },
    sources: { contextWindow: 'override', inputPerMtok: 'registry' },
  }).returning()

  expect(row.registry).toEqual({ contextWindow: 128000, inputPerMtok: 2.5 })
  expect(row.contextWindow).toBe(64000)
  expect(row.inputPerMtok).toBe('2.5')
  expect(row.modalities).toEqual({ input: ['text', 'image'], output: ['text'] })
  expect(row.sources).toEqual({ contextWindow: 'override', inputPerMtok: 'registry' })
})

test('providers carry sync bookkeeping that starts empty', async () => {
  const provider = await makeProvider()
  expect(provider.lastSyncedAt).toBeNull()
  expect(provider.lastSyncStatus).toBeNull()
  expect(provider.lastSyncError).toBeNull()
  expect(provider.lastSyncSummary).toBeNull()

  const [updated] = await db.update(providers).set({
    lastSyncedAt: new Date(),
    lastSyncStatus: 'ok',
    lastSyncSummary: { added: 3, updated: 12, missing: 1, total: 142 },
  }).where(eq(providers.id, provider.id)).returning()

  expect(updated.lastSyncStatus).toBe('ok')
  expect(updated.lastSyncSummary).toEqual({ added: 3, updated: 12, missing: 1, total: 142 })
})

test('registry cache and settings are keyed key-value stores', async () => {
  await db.insert(registryCache).values({
    url: 'https://models.dev/api.json', payload: { 'openai/gpt-4o': { contextWindow: 128000 } },
  })
  const [cache] = await db.select().from(registryCache)
  expect(cache.payload).toEqual({ 'openai/gpt-4o': { contextWindow: 128000 } })
  expect(cache.fetchedAt).toBeInstanceOf(Date)

  await db.insert(settings).values({ key: 'catalog.registry_enabled', value: true })
  const [setting] = await db.select().from(settings)
  expect(setting.value).toBe(true)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test tests/lib/db/catalog-schema.test.ts`
Expected: FAIL — `catalogModels` is not exported from `@/lib/db/schema`.

- [ ] **Step 4: Add the schema**

Append to `src/lib/db/schema.ts`, and extend the import from `drizzle-orm/pg-core` to include `jsonb` and `index`:

```ts
export const catalogOriginEnum = pgEnum('catalog_origin', ['discovered', 'manual'])

export const catalogStatusEnum = pgEnum('catalog_status', ['available', 'missing'])

export const modelKindEnum = pgEnum('model_kind', [
  'chat', 'embedding', 'image', 'audio', 'video', 'unknown',
])

export const syncStatusEnum = pgEnum('sync_status', ['ok', 'failed', 'unsupported'])

export const catalogModels = pgTable(
  'catalog_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    canonicalKey: text('canonical_key'),
    origin: catalogOriginEnum('origin').notNull().default('discovered'),
    status: catalogStatusEnum('status').notNull().default('available'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    // Raw layers. `override` is the only one a human writes.
    discovered: jsonb('discovered').$type<Record<string, unknown>>().notNull().default({}),
    registry: jsonb('registry').$type<Record<string, unknown>>().notNull().default({}),
    seed: jsonb('seed').$type<Record<string, unknown>>().notNull().default({}),
    override: jsonb('override').$type<Record<string, unknown>>().notNull().default({}),

    // Effective values, written by merge().
    kind: modelKindEnum('kind').notNull().default('unknown'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    inputPerMtok: numeric('input_per_mtok', { precision: 12, scale: 6 }),
    outputPerMtok: numeric('output_per_mtok', { precision: 12, scale: 6 }),
    cachedInputPerMtok: numeric('cached_input_per_mtok', { precision: 12, scale: 6 }),
    supportsTools: boolean('supports_tools'),
    supportsStreaming: boolean('supports_streaming'),
    modalities: jsonb('modalities').$type<{ input: string[]; output: string[] } | null>(),
    sources: jsonb('sources').$type<Record<string, string>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('catalog_models_provider_model_idx').on(table.providerId, table.modelId),
    index('catalog_models_kind_idx').on(table.kind),
    index('catalog_models_canonical_key_idx').on(table.canonicalKey),
  ],
)

export const registryCache = pgTable('registry_cache', {
  url: text('url').primaryKey(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  etag: text('etag'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CatalogModelRow = typeof catalogModels.$inferSelect
export type RegistryCacheRow = typeof registryCache.$inferSelect
export type SettingRow = typeof settings.$inferSelect
```

Add the four sync-bookkeeping columns inside the existing `providers` table definition, after `enabled`:

```ts
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncStatus: syncStatusEnum('last_sync_status'),
    lastSyncError: text('last_sync_error'),
    lastSyncSummary: jsonb('last_sync_summary').$type<{
      added: number; updated: number; missing: number; total: number
    } | null>(),
```

`syncStatusEnum` is referenced by `providers`, so declare all four enums above the `providers` table rather than at the bottom of the file.

- [ ] **Step 5: Let the test harness truncate the new tables**

In `tests/helpers/db.ts`, replace the `TABLES` constant:

```ts
const TABLES = [
  'catalog_models', 'route_targets', 'virtual_models', 'api_keys', 'users',
  'providers', 'registry_cache', 'settings',
]
```

- [ ] **Step 6: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: a new `drizzle/0001_*.sql` creating four enums, three tables and four `providers` columns. Read it before continuing — if it drops or rewrites an existing table, stop and fix the schema rather than applying it.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test tests/lib/db/catalog-schema.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts tests/lib/db/catalog-schema.test.ts tests/helpers/db.ts drizzle/ docs/superpowers/specs/2026-08-12-model-catalog-design.md
git commit -m "feat(catalog): schema for catalog_models, registry_cache and settings"
```

---

### Task 2: Catalog types and the pure merge

**Files:**
- Create: `src/lib/catalog/types.ts`
- Create: `src/lib/catalog/merge.ts`
- Test: `tests/lib/catalog/merge.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately pure — no DB, no schema import).
- Produces: `ModelKind`, `Modalities`, `CatalogFields`, `EffectiveFields`, `LayerName`, `FieldSource`, `FieldSources`, `CatalogLayers`, `MergeResult` from `@/lib/catalog/types`; `mergeCatalogFields(layers: CatalogLayers, modelId: string): MergeResult` and `inferKindFromId(modelId: string): ModelKind` from `@/lib/catalog/merge`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/catalog/merge.test.ts`:

```ts
import { expect, test } from 'vitest'
import { inferKindFromId, mergeCatalogFields } from '@/lib/catalog/merge'

test('override beats every other layer, field by field', () => {
  const { effective, sources } = mergeCatalogFields({
    override: { contextWindow: 64000 },
    discovered: { contextWindow: 128000, maxOutputTokens: 4096 },
    registry: { contextWindow: 128000, inputPerMtok: 2.5 },
    seed: { contextWindow: 128000, inputPerMtok: 2.4 },
  }, 'gpt-4o')

  expect(effective.contextWindow).toBe(64000)
  expect(sources.contextWindow).toBe('override')
  expect(effective.maxOutputTokens).toBe(4096)
  expect(sources.maxOutputTokens).toBe('discovered')
  expect(effective.inputPerMtok).toBe(2.5)
  expect(sources.inputPerMtok).toBe('registry')
})

test('precedence falls through in order when a layer omits a field', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: {},
    registry: { outputPerMtok: 10 },
    seed: { outputPerMtok: 9, cachedInputPerMtok: 1.25 },
  }, 'gpt-4o')

  expect(effective.outputPerMtok).toBe(10)
  expect(sources.outputPerMtok).toBe('registry')
  expect(effective.cachedInputPerMtok).toBe(1.25)
  expect(sources.cachedInputPerMtok).toBe('seed')
})

test('a cleared override falls through rather than to null', () => {
  const withOverride = mergeCatalogFields({
    override: { contextWindow: 64000 }, registry: { contextWindow: 128000 },
  }, 'gpt-4o')
  expect(withOverride.effective.contextWindow).toBe(64000)

  // Clearing removes the key entirely — it does not write null.
  const cleared = mergeCatalogFields({
    override: {}, registry: { contextWindow: 128000 },
  }, 'gpt-4o')
  expect(cleared.effective.contextWindow).toBe(128000)
  expect(cleared.sources.contextWindow).toBe('registry')
})

test('an explicit null in a layer is treated as absent', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { contextWindow: null }, seed: { contextWindow: 8192 },
  }, 'whatever')

  expect(effective.contextWindow).toBe(8192)
  expect(sources.contextWindow).toBe('seed')
})

test('a field no layer supplies is null with no source', () => {
  const { effective, sources } = mergeCatalogFields({ discovered: {} }, 'mystery-model')
  expect(effective.supportsStreaming).toBeNull()
  expect(sources.supportsStreaming).toBeUndefined()
})

test('false and zero are real values, not absences', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { supportsTools: false, outputPerMtok: 0 },
    registry: { supportsTools: true, outputPerMtok: 10 },
  }, 'text-embedding-3-small')

  expect(effective.supportsTools).toBe(false)
  expect(sources.supportsTools).toBe('discovered')
  expect(effective.outputPerMtok).toBe(0)
  expect(sources.outputPerMtok).toBe('discovered')
})

test('kind comes from the highest layer that claims to know', () => {
  const { effective, sources } = mergeCatalogFields({
    registry: { kind: 'embedding' }, seed: { kind: 'chat' },
  }, 'text-embedding-3-small')

  expect(effective.kind).toBe('embedding')
  expect(sources.kind).toBe('registry')
})

test("a layer's 'unknown' kind does not block a lower layer", () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { kind: 'unknown' }, registry: { kind: 'chat' },
  }, 'gpt-4o')

  expect(effective.kind).toBe('chat')
  expect(sources.kind).toBe('registry')
})

test('the id heuristic runs only after all four layers miss', () => {
  const { effective, sources } = mergeCatalogFields({}, 'text-embedding-3-small')
  expect(effective.kind).toBe('embedding')
  expect(sources.kind).toBe('heuristic')
})

test('the heuristic classifies the kinds discovery cannot', () => {
  expect(inferKindFromId('text-embedding-3-small')).toBe('embedding')
  expect(inferKindFromId('whisper-1')).toBe('audio')
  expect(inferKindFromId('tts-1-hd')).toBe('audio')
  expect(inferKindFromId('dall-e-3')).toBe('image')
  expect(inferKindFromId('imagen-4-fast')).toBe('image')
  expect(inferKindFromId('veo-3')).toBe('video')
})

test('an unrecognised id is unknown, not chat', () => {
  // The picker groups unknown last; guessing "chat" would hide a wrong guess.
  expect(inferKindFromId('ft:gpt-4o:acme:x2')).toBe('unknown')
  expect(inferKindFromId('llama3.1:8b')).toBe('unknown')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/catalog/merge.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/merge`.

- [ ] **Step 3: Write the types**

Create `src/lib/catalog/types.ts`:

```ts
export const modelKinds = [
  'chat', 'embedding', 'image', 'audio', 'video', 'unknown',
] as const
export type ModelKind = (typeof modelKinds)[number]

export interface Modalities {
  input: string[]
  output: string[]
}

/** One layer's contribution. Absent and null both mean "this layer does not know". */
export interface CatalogFields {
  kind?: ModelKind | null
  contextWindow?: number | null
  maxOutputTokens?: number | null
  inputPerMtok?: number | null
  outputPerMtok?: number | null
  cachedInputPerMtok?: number | null
  supportsTools?: boolean | null
  supportsStreaming?: boolean | null
  modalities?: Modalities | null
}

export interface EffectiveFields {
  kind: ModelKind
  contextWindow: number | null
  maxOutputTokens: number | null
  inputPerMtok: number | null
  outputPerMtok: number | null
  cachedInputPerMtok: number | null
  supportsTools: boolean | null
  supportsStreaming: boolean | null
  modalities: Modalities | null
}

export type LayerName = 'override' | 'discovered' | 'registry' | 'seed'
export type FieldSource = LayerName | 'heuristic'
export type FieldSources = Partial<Record<keyof EffectiveFields, FieldSource>>

export interface CatalogLayers {
  override?: CatalogFields | null
  discovered?: CatalogFields | null
  registry?: CatalogFields | null
  seed?: CatalogFields | null
}

export interface MergeResult {
  effective: EffectiveFields
  sources: FieldSources
}
```

- [ ] **Step 4: Write the merge**

Create `src/lib/catalog/merge.ts`:

```ts
import type {
  CatalogFields, CatalogLayers, EffectiveFields, FieldSources, LayerName,
  MergeResult, ModelKind,
} from './types'

/** Highest precedence first. */
const LAYER_ORDER: readonly LayerName[] = ['override', 'discovered', 'registry', 'seed']

const VALUE_FIELDS = [
  'contextWindow', 'maxOutputTokens', 'inputPerMtok', 'outputPerMtok',
  'cachedInputPerMtok', 'supportsTools', 'supportsStreaming', 'modalities',
] as const satisfies readonly Exclude<keyof EffectiveFields, 'kind'>[]

/**
 * Last-resort classification for models no layer describes — OpenAI's
 * /v1/models reports nothing but an id, and models.dev has no entry for
 * whisper, tts or dall-e. Anything unrecognised stays `unknown` rather than
 * being guessed into `chat`: the picker groups unknown last, so a wrong guess
 * would be less visible than an honest one.
 */
export function inferKindFromId(modelId: string): ModelKind {
  const id = modelId.toLowerCase()
  if (/embed/.test(id)) return 'embedding'
  if (/whisper|(^|[-_/.])tts([-_/.]|$)|transcrib|speech/.test(id)) return 'audio'
  if (/dall-e|imagen|stable-?diffusion|flux|(^|[-_/.])sdxl([-_/.]|$)/.test(id)) return 'image'
  if (/(^|[-_/.])(veo|sora)([-_/.]|$)/.test(id)) return 'video'
  return 'unknown'
}

export function mergeCatalogFields(layers: CatalogLayers, modelId: string): MergeResult {
  // Accumulate into a plain record and cast once at the return boundary.
  // Casting EffectiveFields to an index-signature type mid-loop does not
  // type-check (TS2352) — it has no index signature.
  const effective: Record<string, unknown> = {}
  const sources: FieldSources = {}

  for (const field of VALUE_FIELDS) {
    let resolved: CatalogFields[typeof field] = null

    for (const layer of LAYER_ORDER) {
      const candidate = layers[layer]?.[field]
      if (candidate !== undefined && candidate !== null) {
        resolved = candidate
        sources[field] = layer
        break
      }
    }

    effective[field] = resolved ?? null
  }

  let kind: ModelKind | null = null
  for (const layer of LAYER_ORDER) {
    const candidate = layers[layer]?.kind
    // 'unknown' means the layer looked and could not tell — not an answer.
    if (candidate && candidate !== 'unknown') {
      kind = candidate
      sources.kind = layer
      break
    }
  }
  if (!kind) {
    kind = inferKindFromId(modelId)
    sources.kind = 'heuristic'
  }
  effective.kind = kind

  return { effective: effective as unknown as EffectiveFields, sources }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/merge.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/catalog/types.ts src/lib/catalog/merge.ts tests/lib/catalog/merge.test.ts
git commit -m "feat(catalog): pure layer merge with field-level precedence"
```

---

### Task 3: Canonical key normalization

**Files:**
- Create: `src/lib/catalog/normalize.ts`
- Test: `tests/lib/catalog/normalize.test.ts`

**Interfaces:**
- Consumes: `AdapterType` from `@/lib/adapters/credentials`.
- Produces: `canonicalKeyCandidates(adapter: AdapterType, modelId: string, registryNamespace?: string | null): string[]` and `REGISTRY_NAMESPACE: Record<AdapterType, string | null>` from `@/lib/catalog/normalize`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/catalog/normalize.test.ts`:

```ts
import { expect, test } from 'vitest'
import { canonicalKeyCandidates } from '@/lib/catalog/normalize'

test('openai ids are namespaced as-is', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o')).toEqual(['openai/gpt-4o'])
})

test('a dated openai snapshot falls back to its undated id', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o-2024-08-06')).toEqual([
    'openai/gpt-4o-2024-08-06',
    'openai/gpt-4o',
  ])
})

test('gemini ids drop the models/ prefix', () => {
  expect(canonicalKeyCandidates('gemini', 'models/gemini-flash-latest')).toEqual([
    'google/models/gemini-flash-latest',
    'google/gemini-flash-latest',
  ])
})

test('a regioned bedrock id is tried as-is first, then unregioned', () => {
  // models.dev stores bedrock ids verbatim, region prefix and -v1:0 included.
  expect(canonicalKeyCandidates('bedrock', 'us.deepseek.r1-v1:0')).toEqual([
    'amazon-bedrock/us.deepseek.r1-v1:0',
    'amazon-bedrock/deepseek.r1-v1:0',
  ])
})

test('an unregioned bedrock id tries the known region prefixes', () => {
  expect(canonicalKeyCandidates('bedrock', 'anthropic.claude-opus-4-5-20251101-v1:0')).toEqual([
    'amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/eu.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/apac.anthropic.claude-opus-4-5-20251101-v1:0',
    'amazon-bedrock/global.anthropic.claude-opus-4-5-20251101-v1:0',
  ])
})

test('openai_compatible with no namespace configured produces no candidates', () => {
  // ollama has no models.dev namespace at all, and the namespace cannot be
  // guessed from a base URL. Unmatched is the correct outcome.
  expect(canonicalKeyCandidates('openai_compatible', 'llama3.1:8b')).toEqual([])
})

test('a configured namespace is applied to openai_compatible ids', () => {
  expect(canonicalKeyCandidates('openai_compatible', 'llama-3.3-70b', 'groq')).toEqual([
    'groq/llama-3.3-70b',
  ])
})

test('a slash-bearing openai_compatible id is also tried verbatim', () => {
  // OpenRouter-style ids already carry a vendor segment.
  expect(canonicalKeyCandidates('openai_compatible', 'openai/gpt-4o', 'openrouter')).toEqual([
    'openrouter/openai/gpt-4o',
    'openai/gpt-4o',
  ])
})

test('a configured namespace overrides the adapter default', () => {
  expect(canonicalKeyCandidates('gemini', 'gemini-2.5-pro', 'google-vertex')).toEqual([
    'google-vertex/gemini-2.5-pro',
  ])
})

test('a blank namespace is ignored rather than producing a bare slash', () => {
  expect(canonicalKeyCandidates('openai', 'gpt-4o', '   ')).toEqual(['openai/gpt-4o'])
})

test('candidates are de-duplicated and order is stable', () => {
  const keys = canonicalKeyCandidates('openai', 'gpt-4o')
  expect(new Set(keys).size).toBe(keys.length)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/catalog/normalize.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/normalize`.

- [ ] **Step 3: Write the normalizer**

Create `src/lib/catalog/normalize.ts`:

```ts
import type { AdapterType } from '@/lib/adapters/credentials'

/**
 * models.dev keys every model under a provider slug. These are the defaults
 * per adapter; `openai_compatible` has none, because the endpoint behind it
 * could be anything (and ollama has no models.dev namespace at all), so its
 * provider config must name one via `registryNamespace`.
 */
export const REGISTRY_NAMESPACE: Record<AdapterType, string | null> = {
  openai: 'openai',
  openai_compatible: null,
  gemini: 'google',
  bedrock: 'amazon-bedrock',
}

// One list defines the concept: the strip pattern is derived from it, so the
// two directions cannot drift apart.
const BEDROCK_REGIONS = ['us', 'eu', 'apac', 'global'] as const
const BEDROCK_REGION_PREFIX = new RegExp(`^(?:${BEDROCK_REGIONS.join('|')})\\.`)
const OPENAI_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

/** Bare model ids to try, most specific first, before namespacing. */
function idCandidates(adapter: AdapterType, modelId: string): string[] {
  const ids = [modelId]

  switch (adapter) {
    case 'openai': {
      const undated = modelId.replace(OPENAI_DATE_SUFFIX, '')
      if (undated !== modelId) ids.push(undated)
      break
    }
    case 'gemini': {
      const bare = modelId.replace(/^models\//, '')
      if (bare !== modelId) ids.push(bare)
      break
    }
    case 'bedrock': {
      const unregioned = modelId.replace(BEDROCK_REGION_PREFIX, '')
      if (unregioned !== modelId) ids.push(unregioned)
      else for (const region of BEDROCK_REGIONS) ids.push(`${region}.${modelId}`)
      break
    }
    case 'openai_compatible':
      break
  }

  return ids
}

/**
 * Candidate models.dev keys for one discovered model, in the order they should
 * be tried. An empty array means the model cannot be matched, which is a real
 * and expected outcome — the UI surfaces it so an admin can set a namespace or
 * enter an override.
 */
export function canonicalKeyCandidates(
  adapter: AdapterType,
  modelId: string,
  registryNamespace?: string | null,
): string[] {
  const namespace = registryNamespace?.trim() || REGISTRY_NAMESPACE[adapter]
  const keys: string[] = []

  if (namespace) {
    for (const id of idCandidates(adapter, modelId)) keys.push(`${namespace}/${id}`)
  }

  // An id that already carries a vendor segment ("openai/gpt-4o" from an
  // OpenRouter-style proxy) may match another namespace directly.
  if (adapter === 'openai_compatible' && modelId.includes('/')) keys.push(modelId)

  return [...new Set(keys)]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/normalize.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/normalize.ts tests/lib/catalog/normalize.test.ts
git commit -m "feat(catalog): per-adapter canonical key candidates"
```

---

### Task 4: Settings, models.dev projection, and the cached registry client

**Files:**
- Create: `src/lib/settings.ts`
- Create: `src/lib/catalog/registry.ts`
- Create: `tests/fixtures/models-dev.json`
- Test: `tests/lib/settings.test.ts`
- Test: `tests/lib/catalog/registry.test.ts`

**Interfaces:**
- Consumes: `settings`, `registryCache` from `@/lib/db/schema` (Task 1); `CatalogFields`, `ModelKind`, `Modalities` from `@/lib/catalog/types` (Task 2).
- Produces: `CatalogSettings`, `getCatalogSettings()`, `setCatalogSettings(patch)`, `DEFAULT_REGISTRY_URL` from `@/lib/settings`; `RegistryIndex`, `RegistryStatus`, `RegistryLoad`, `projectModelsDev(doc)`, `kindFromModelsDev(model)`, `loadRegistry(opts)`, `REGISTRY_MAX_AGE_MS` from `@/lib/catalog/registry`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/models-dev.json` — a trimmed excerpt of the real document, keeping only the fields the projection reads. The four entries are chosen to cover every branch of `kindFromModelsDev`:

```json
{
  "openai": {
    "id": "openai",
    "name": "OpenAI",
    "models": {
      "gpt-4o": {
        "id": "gpt-4o",
        "family": "gpt",
        "temperature": true,
        "tool_call": true,
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
        "limit": { "context": 128000, "output": 16384 },
        "cost": { "input": 2.5, "output": 10, "cache_read": 1.25 }
      },
      "text-embedding-3-small": {
        "id": "text-embedding-3-small",
        "family": "text-embedding",
        "temperature": false,
        "tool_call": false,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 8191, "output": 1536 },
        "cost": { "input": 0.02, "output": 0 }
      }
    }
  },
  "amazon-bedrock": {
    "id": "amazon-bedrock",
    "name": "Amazon Bedrock",
    "models": {
      "us.deepseek.r1-v1:0": {
        "id": "us.deepseek.r1-v1:0",
        "family": "deepseek",
        "temperature": true,
        "tool_call": false,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 128000, "output": 32768 },
        "cost": { "input": 1.35, "output": 5.4 }
      }
    }
  },
  "poe": {
    "id": "poe",
    "name": "Poe",
    "models": {
      "google/veo-3": {
        "id": "google/veo-3",
        "family": "veo",
        "temperature": false,
        "tool_call": false,
        "modalities": { "input": ["text"], "output": ["video"] },
        "limit": { "context": 1024, "output": 1 },
        "cost": { "input": 0, "output": 0 }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing settings test**

Create `tests/lib/settings.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import {
  DEFAULT_REGISTRY_URL, getCatalogSettings, setCatalogSettings,
} from '@/lib/settings'
import { resetDb } from '../helpers/db'

beforeEach(resetDb)

test('defaults to the registry enabled at models.dev', async () => {
  const settings = await getCatalogSettings()
  expect(settings.registryEnabled).toBe(true)
  expect(settings.registryUrl).toBe(DEFAULT_REGISTRY_URL)
  expect(DEFAULT_REGISTRY_URL).toBe('https://models.dev/api.json')
})

test('a stored false survives the default', async () => {
  await setCatalogSettings({ registryEnabled: false })
  expect((await getCatalogSettings()).registryEnabled).toBe(false)
})

test('setting one key leaves the other alone', async () => {
  await setCatalogSettings({ registryUrl: 'https://mirror.internal/api.json' })
  const settings = await getCatalogSettings()
  expect(settings.registryUrl).toBe('https://mirror.internal/api.json')
  expect(settings.registryEnabled).toBe(true)
})

test('writing the same key twice updates rather than conflicts', async () => {
  await setCatalogSettings({ registryEnabled: false })
  const settings = await setCatalogSettings({ registryEnabled: true })
  expect(settings.registryEnabled).toBe(true)
})

test('a malformed or empty registry URL is refused', async () => {
  await expect(setCatalogSettings({ registryUrl: 'not a url' })).rejects.toThrow(/valid URL/i)
  await expect(setCatalogSettings({ registryUrl: '   ' })).rejects.toThrow(/required/i)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test tests/lib/settings.test.ts`
Expected: FAIL — cannot resolve `@/lib/settings`.

- [ ] **Step 4: Write the settings module**

Create `src/lib/settings.ts`:

```ts
import 'server-only'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'

export const DEFAULT_REGISTRY_URL = 'https://models.dev/api.json'

export interface CatalogSettings {
  registryEnabled: boolean
  registryUrl: string
}

const KEYS = {
  registryEnabled: 'catalog.registry_enabled',
  registryUrl: 'catalog.registry_url',
} as const

export async function getCatalogSettings(): Promise<CatalogSettings> {
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((row) => [row.key, row.value]))

  const enabled = byKey.get(KEYS.registryEnabled)
  const url = byKey.get(KEYS.registryUrl)

  return {
    registryEnabled: typeof enabled === 'boolean' ? enabled : true,
    registryUrl: typeof url === 'string' && url.length > 0 ? url : DEFAULT_REGISTRY_URL,
  }
}

export async function setCatalogSettings(
  patch: Partial<CatalogSettings>,
): Promise<CatalogSettings> {
  const writes: Array<[string, unknown]> = []

  if (patch.registryEnabled !== undefined) {
    writes.push([KEYS.registryEnabled, patch.registryEnabled])
  }
  if (patch.registryUrl !== undefined) {
    const url = patch.registryUrl.trim()
    if (!url) throw new Error('A registry URL is required.')
    try {
      new URL(url)
    } catch {
      throw new Error(`"${url}" is not a valid URL.`)
    }
    writes.push([KEYS.registryUrl, url])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  }

  return getCatalogSettings()
}
```

- [ ] **Step 5: Run the settings test to verify it passes**

Run: `pnpm test tests/lib/settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing registry test**

Create `tests/lib/catalog/registry.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { registryCache } from '@/lib/db/schema'
import { setCatalogSettings } from '@/lib/settings'
import {
  REGISTRY_MAX_AGE_MS, kindFromModelsDev, loadRegistry, projectModelsDev,
} from '@/lib/catalog/registry'
import fixture from '../../fixtures/models-dev.json'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

const URL_DEFAULT = 'https://models.dev/api.json'

function okFetch(body: unknown = fixture) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: 'OK', json: async () => body,
  }) as unknown as typeof fetch
}

test('projection keys every model by provider slug', () => {
  const index = projectModelsDev(fixture)
  expect(Object.keys(index).sort()).toEqual([
    'amazon-bedrock/us.deepseek.r1-v1:0',
    'openai/gpt-4o',
    'openai/text-embedding-3-small',
    'poe/google/veo-3',
  ])
})

test('projection maps limits, costs and tool support', () => {
  const entry = projectModelsDev(fixture)['openai/gpt-4o']
  expect(entry).toEqual({
    kind: 'chat',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPerMtok: 2.5,
    outputPerMtok: 10,
    cachedInputPerMtok: 1.25,
    supportsTools: true,
    supportsStreaming: null,
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  })
})

test('a missing cache_read becomes null rather than undefined', () => {
  expect(projectModelsDev(fixture)['amazon-bedrock/us.deepseek.r1-v1:0'].cachedInputPerMtok)
    .toBeNull()
})

test('kind is derived where models.dev has no marker for it', () => {
  const index = projectModelsDev(fixture)
  expect(index['openai/gpt-4o'].kind).toBe('chat')
  expect(index['openai/text-embedding-3-small'].kind).toBe('embedding')
  expect(index['poe/google/veo-3'].kind).toBe('video')
})

test('kind derivation prefers output modality, then family, then zero-cost', () => {
  expect(kindFromModelsDev({ modalities: { output: ['image'] } })).toBe('image')
  expect(kindFromModelsDev({ modalities: { output: ['audio'] } })).toBe('audio')
  expect(kindFromModelsDev({ family: 'gemini-embedding' })).toBe('embedding')
  expect(kindFromModelsDev({ cost: { output: 0 }, temperature: false })).toBe('embedding')
  expect(kindFromModelsDev({ cost: { output: 0 }, temperature: true })).toBe('chat')
  expect(kindFromModelsDev({})).toBe('chat')
})

test('a garbage document projects to an empty index instead of throwing', () => {
  expect(projectModelsDev(null)).toEqual({})
  expect(projectModelsDev('nope')).toEqual({})
  expect(projectModelsDev({ openai: { models: 'not an object' } })).toEqual({})
})

test('a first load fetches and caches the projection', async () => {
  const fetchImpl = okFetch()
  const result = await loadRegistry({ fetchImpl })

  expect(result.status).toBe('fresh')
  expect(result.error).toBeNull()
  expect(result.index['openai/gpt-4o'].contextWindow).toBe(128000)
  expect(fetchImpl).toHaveBeenCalledTimes(1)

  const [cached] = await db.select().from(registryCache)
  expect(cached.url).toBe(URL_DEFAULT)
  expect(Object.keys(cached.payload)).toContain('openai/gpt-4o')
})

test('a fresh cache is reused without fetching', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.status).toBe('cached')
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('a stale cache triggers a refetch', async () => {
  const start = new Date('2026-08-10T00:00:00Z')
  await loadRegistry({ fetchImpl: okFetch(), now: start })

  const fetchImpl = okFetch()
  const later = new Date(start.getTime() + REGISTRY_MAX_AGE_MS + 1)
  const result = await loadRegistry({ fetchImpl, now: later })

  expect(result.status).toBe('fresh')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('force refetches even when the cache is fresh', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = okFetch()

  await loadRegistry({ fetchImpl, force: true })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('a failed fetch falls back to the cache and reports why', async () => {
  await loadRegistry({ fetchImpl: okFetch() })

  const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
  const result = await loadRegistry({ fetchImpl, force: true })

  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/ECONNREFUSED/)
  expect(result.index['openai/gpt-4o']).toBeDefined()
})

test('a failed fetch with no cache degrades to an empty index, not a throw', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch
  const result = await loadRegistry({ fetchImpl })

  expect(result.status).toBe('failed')
  expect(result.error).toMatch(/ENOTFOUND/)
  expect(result.index).toEqual({})
})

test('a non-2xx response is a failure, not an empty catalog overwrite', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}),
  }) as unknown as typeof fetch

  const result = await loadRegistry({ fetchImpl, force: true })
  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/503/)
})

test('an empty document is refused so it cannot wipe a good cache', async () => {
  await loadRegistry({ fetchImpl: okFetch() })
  const result = await loadRegistry({ fetchImpl: okFetch({}), force: true })

  expect(result.status).toBe('cached')
  expect(result.error).toMatch(/no models/i)
  expect(result.index['openai/gpt-4o']).toBeDefined()
})

test('disabling the registry skips the fetch entirely', async () => {
  await setCatalogSettings({ registryEnabled: false })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.status).toBe('disabled')
  expect(result.index).toEqual({})
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('the configured URL is what gets fetched and cached', async () => {
  await setCatalogSettings({ registryUrl: 'https://mirror.internal/api.json' })
  const fetchImpl = okFetch()

  const result = await loadRegistry({ fetchImpl })
  expect(result.url).toBe('https://mirror.internal/api.json')
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://mirror.internal/api.json',
    expect.objectContaining({ headers: { accept: 'application/json' } }),
  )
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm test tests/lib/catalog/registry.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/registry`.

- [ ] **Step 8: Write the registry module**

Create `src/lib/catalog/registry.ts`:

```ts
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
```

- [ ] **Step 9: Run the registry test to verify it passes**

Run: `pnpm test tests/lib/catalog/registry.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 10: Commit**

```bash
git add src/lib/settings.ts src/lib/catalog/registry.ts tests/lib/settings.test.ts tests/lib/catalog/registry.test.ts tests/fixtures/models-dev.json
git commit -m "feat(catalog): models.dev projection with a cached, opt-in registry client"
```

---

### Task 5: Vendored seed snapshot and its refresh script

**Files:**
- Create: `src/lib/catalog/seed.ts`
- Create: `src/lib/catalog/seed/models.json` (generated, ~1.6 MB)
- Create: `scripts/refresh-seed.mjs`
- Modify: `package.json` (add the `seed:refresh` script)
- Test: `tests/lib/catalog/seed.test.ts`

**Interfaces:**
- Consumes: `projectModelsDev`, `RegistryIndex` from `@/lib/catalog/registry` (Task 4).
- Produces: `loadSeed(): RegistryIndex` from `@/lib/catalog/seed`.

- [ ] **Step 1: Write the refresh script**

Create `scripts/refresh-seed.mjs`. It writes the models.dev document **trimmed to the fields the projection reads**, not a pre-projected index — so `loadSeed()` and `loadRegistry()` run the exact same parser over the exact same shape, which is the property the test in Step 5 asserts.

```js
#!/usr/bin/env node
// Regenerates src/lib/catalog/seed/models.json — the offline floor for a
// fresh install that has never reached the network.
//
//   node scripts/refresh-seed.mjs
//
// The output is generated. Do not hand-edit it; re-run this and review the
// diff. A large diff is expected and normal.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = process.env.REGISTRY_URL ?? 'https://models.dev/api.json'
const OUT = path.join(import.meta.dirname, '..', 'src', 'lib', 'catalog', 'seed', 'models.json')

// Exactly the keys projectModelsDev() reads. Anything else is dead weight.
const MODEL_FIELDS = ['id', 'family', 'temperature', 'tool_call', 'modalities', 'limit', 'cost']

function pick(source, fields) {
  const out = {}
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}

const response = await fetch(SOURCE, { headers: { accept: 'application/json' } })
if (!response.ok) {
  console.error(`Failed to fetch ${SOURCE}: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const doc = await response.json()
const trimmed = {}
let providers = 0
let models = 0

for (const [slug, provider] of Object.entries(doc)) {
  if (!provider || typeof provider !== 'object' || !provider.models) continue
  const entries = {}
  for (const [id, model] of Object.entries(provider.models)) {
    entries[id] = pick(model, MODEL_FIELDS)
    models += 1
  }
  trimmed[slug] = { id: provider.id ?? slug, name: provider.name ?? slug, models: entries }
  providers += 1
}

if (models === 0) {
  console.error('Refusing to write an empty seed.')
  process.exit(1)
}

await mkdir(path.dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(trimmed, null, 0)}\n`)
console.log(`Wrote ${providers} providers / ${models} models to ${path.relative(process.cwd(), OUT)}`)
```

Add to `package.json` scripts, after `db:deploy`:

```json
    "seed:refresh": "node scripts/refresh-seed.mjs"
```

- [ ] **Step 2: Generate the snapshot**

```bash
pnpm seed:refresh
ls -lh src/lib/catalog/seed/models.json
```

Expected: roughly 180 providers / 6000+ models, about 1.5–2 MB. If it reports fewer than 100 providers, models.dev returned something unexpected — stop and inspect before committing.

- [ ] **Step 3: Write the failing test**

Create `tests/lib/catalog/seed.test.ts`:

```ts
import { expect, test } from 'vitest'
import { loadSeed } from '@/lib/catalog/seed'
import { projectModelsDev } from '@/lib/catalog/registry'
import fixture from '../../fixtures/models-dev.json'

test('the vendored snapshot loads through the same projection as the registry', () => {
  // The seed's whole purpose is being the same shape from a different source.
  // If refresh-seed.mjs ever writes something else, this is what catches it.
  const seed = loadSeed()
  const live = projectModelsDev(fixture)

  const seedEntry = seed['openai/gpt-4o']
  expect(seedEntry).toBeDefined()
  expect(Object.keys(seedEntry).sort()).toEqual(Object.keys(live['openai/gpt-4o']).sort())
})

test('the snapshot covers every adapter namespace the normalizer targets', () => {
  const seed = loadSeed()
  const namespaces = new Set(Object.keys(seed).map((key) => key.split('/')[0]))

  expect(namespaces.has('openai')).toBe(true)
  expect(namespaces.has('google')).toBe(true)
  expect(namespaces.has('amazon-bedrock')).toBe(true)
})

test('the snapshot carries real pricing and limits', () => {
  const entry = loadSeed()['openai/gpt-4o']
  expect(entry.contextWindow).toBeGreaterThan(0)
  expect(entry.inputPerMtok).toBeGreaterThan(0)
  expect(entry.kind).toBe('chat')
})

test('loading is memoized so repeated syncs do not re-parse megabytes', () => {
  expect(loadSeed()).toBe(loadSeed())
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm test tests/lib/catalog/seed.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/seed`.

- [ ] **Step 5: Write the seed loader**

Create `src/lib/catalog/seed.ts`:

```ts
import { projectModelsDev, type RegistryIndex } from './registry'
import snapshot from './seed/models.json'

let cached: RegistryIndex | null = null

/**
 * The offline floor: a vendored models.dev snapshot, parsed by the same
 * projection the live registry uses. Memoized because the document is a
 * couple of megabytes and every provider sync asks for it.
 *
 * Regenerate with `pnpm seed:refresh`. Do not hand-edit the JSON.
 */
export function loadSeed(): RegistryIndex {
  cached ??= projectModelsDev(snapshot)
  return cached
}
```

Note: `src/lib/catalog/registry.ts` imports `server-only`, so `seed.ts` is server-only transitively — which is correct, and `vitest.config.ts` already aliases `server-only` to its empty module.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/seed.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/catalog/seed.ts src/lib/catalog/seed/models.json scripts/refresh-seed.mjs package.json tests/lib/catalog/seed.test.ts
git commit -m "feat(catalog): vendored models.dev snapshot as the offline seed layer"
```

---

### Task 6: Adapter model listing

**Files:**
- Modify: `src/lib/adapters/types.ts`
- Modify: `src/lib/adapters/openai/index.ts:42-68`
- Test: `tests/lib/adapters/openai/models.test.ts`

**Interfaces:**
- Consumes: `CatalogFields` from `@/lib/catalog/types` (Task 2); `AdapterType` from `@/lib/adapters/credentials`.
- Produces: `DiscoveredModel`, `ListModelsContext` and the optional `ProviderAdapter.listModels(ctx)` from `@/lib/adapters/types`; a `listModels` implementation on the OpenAI adapter.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/adapters/openai/models.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'openai-prod',
  adapter: 'openai',
  baseUrl: null,
  credentials: { apiKey: 'sk-test' },
  config: {},
}

/** models.list() returns a paginated async-iterable, not a plain array. */
function fakeClient(models: Array<Record<string, unknown>>) {
  const list = vi.fn().mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      for (const model of models) yield model
    },
  })
  const factory = vi.fn().mockReturnValue({ models: { list } })
  return { list, factory }
}

test('lists every model id the provider reports', async () => {
  const { factory } = fakeClient([
    { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
    { id: 'text-embedding-3-small', object: 'model', owned_by: 'openai' },
    { id: 'whisper-1', object: 'model', owned_by: 'openai-internal' },
  ])
  const adapter = createOpenAIAdapter(runtime, factory as never)

  const models = await adapter.listModels!({ signal: new AbortController().signal })

  expect(models.map((m) => m.id)).toEqual([
    'gpt-4o', 'text-embedding-3-small', 'whisper-1',
  ])
})

test('reports no fields, because /v1/models carries no metadata', async () => {
  const { factory } = fakeClient([{ id: 'gpt-4o', object: 'model', created: 1 }])
  const adapter = createOpenAIAdapter(runtime, factory as never)

  const [model] = await adapter.listModels!({ signal: new AbortController().signal })

  expect(model.fields).toEqual({})
  expect(model.raw).toEqual({ id: 'gpt-4o', object: 'model', created: 1 })
})

test('threads the abort signal into the upstream call', async () => {
  const { list, factory } = fakeClient([])
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const signal = new AbortController().signal

  await adapter.listModels!({ signal })

  expect(list).toHaveBeenCalledWith(expect.objectContaining({ signal }))
})

test('an entry with no usable id is skipped rather than stored blank', async () => {
  const { factory } = fakeClient([{ id: 'gpt-4o' }, { object: 'model' }, { id: '' }])
  const adapter = createOpenAIAdapter(runtime, factory as never)

  const models = await adapter.listModels!({ signal: new AbortController().signal })
  expect(models.map((m) => m.id)).toEqual(['gpt-4o'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/adapters/openai/models.test.ts`
Expected: FAIL — `adapter.listModels` is undefined.

- [ ] **Step 3: Extend the adapter interface**

In `src/lib/adapters/types.ts`, add the import and the two new types, and add `listModels` to `ProviderAdapter`:

```ts
import type { AdapterType } from '@/lib/adapters/credentials'
import type { CatalogFields } from '@/lib/catalog/types'
```

```ts
/** One model a provider reports it can serve. */
export interface DiscoveredModel {
  id: string
  /**
   * Whatever the adapter could map onto catalog fields. Empty for every
   * OpenAI-shaped provider, whose /v1/models reports nothing but an id.
   */
  fields: CatalogFields
  /** The provider's raw entry, kept for debugging. */
  raw: unknown
}

export interface ListModelsContext {
  signal: AbortSignal
}
```

```ts
export interface ProviderAdapter {
  chat(req: ChatCompletionRequest, ctx: AttemptContext): Promise<ChatCompletion>
  chatStream(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): AsyncIterable<ChatCompletionChunk>
  /**
   * Optional: adapters that cannot enumerate models simply omit it, and the
   * sync reports `unsupported` rather than failing.
   */
  listModels?(ctx: ListModelsContext): Promise<DiscoveredModel[]>
}
```

While in this file, close a Phase 1 handoff item: `ProviderRuntime.adapter` currently re-declares the adapter union by hand, which is self-checking only because the two lists happen to match. Replace it:

```ts
export interface ProviderRuntime {
  id: string
  name: string
  adapter: AdapterType
  baseUrl: string | null
  credentials: Record<string, unknown>
  config: ProviderConfig
}
```

Also document the new provider config field on `ProviderConfig`, above the index signature:

```ts
  /**
   * models.dev namespace this provider's models live under ("groq",
   * "openrouter"). Only meaningful for `openai_compatible`, whose endpoint
   * could be anything; without it those models stay unmatched in the catalog.
   */
  registryNamespace?: string
```

- [ ] **Step 4: Implement listModels on the OpenAI adapter**

In `src/lib/adapters/openai/index.ts`, add to the returned object after `chatStream`, and extend the type import to include `DiscoveredModel` and `ListModelsContext`:

```ts
    async listModels(ctx: ListModelsContext): Promise<DiscoveredModel[]> {
      const page = await client.models.list({ signal: ctx.signal })
      const models: DiscoveredModel[] = []

      for await (const model of page) {
        // Some openai_compatible clones return entries with no id at all.
        if (typeof model?.id !== 'string' || model.id.length === 0) continue
        // /v1/models reports id, created and owned_by — nothing the catalog
        // can merge. Enrichment comes from the registry and seed layers.
        models.push({ id: model.id, fields: {}, raw: model })
      }

      return models
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/adapters/openai/models.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify nothing else broke and commit**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: the full suite passes; `ProviderRuntime.adapter` narrowing to `AdapterType` type-checks everywhere.

```bash
git add src/lib/adapters/types.ts src/lib/adapters/openai/index.ts tests/lib/adapters/openai/models.test.ts
git commit -m "feat(catalog): optional listModels on the adapter interface, implemented for OpenAI"
```

---

### Task 7: Sync orchestration

**Files:**
- Create: `src/lib/catalog/sync.ts`
- Test: `tests/lib/catalog/sync.test.ts`

**Interfaces:**
- Consumes: `catalogModels`, `providers` from `@/lib/db/schema` (Task 1); `mergeCatalogFields` (Task 2); `canonicalKeyCandidates` (Task 3); `loadRegistry`, `RegistryLoad`, `RegistryIndex`, `RegistryStatus` (Task 4); `loadSeed` (Task 5); `DiscoveredModel`, `ProviderAdapter` (Task 6); `createAdapter` from `@/lib/adapters/registry`; `UnsupportedOperationError` from `@/lib/gateway/errors`; `pool` from `@/lib/db`.
- Produces: `SyncSummary`, `SyncResult`, `DISCOVERY_TIMEOUT_MS`, `describeDiscoveryError(err)`, `syncProvider(providerId, opts?)`, `syncAllProviders(opts?)` from `@/lib/catalog/sync`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/catalog/sync.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type { DiscoveredModel, ProviderAdapter } from '@/lib/adapters/types'
import { describeDiscoveryError, syncAllProviders, syncProvider } from '@/lib/catalog/sync'
import type { RegistryLoad } from '@/lib/catalog/registry'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

const registry: RegistryLoad = {
  index: {
    'openai/gpt-4o': {
      kind: 'chat', contextWindow: 128000, maxOutputTokens: 16384,
      inputPerMtok: 2.5, outputPerMtok: 10, cachedInputPerMtok: 1.25,
      supportsTools: true, supportsStreaming: null,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  },
  status: 'cached',
  url: 'https://models.dev/api.json',
  fetchedAt: new Date('2026-08-12T00:00:00Z'),
  error: null,
}

async function makeProvider(name = 'openai-prod', config = '{}') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }), config,
  }).returning()
  return row
}

function adapterListing(ids: string[]): ProviderAdapter {
  return {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue(
      ids.map((id): DiscoveredModel => ({ id, fields: {}, raw: { id } })),
    ),
  } as unknown as ProviderAdapter
}

function opts(adapter: ProviderAdapter) {
  return { registry, createAdapterImpl: () => adapter }
}

async function rowsFor(providerId: string) {
  return db.select().from(catalogModels)
    .where(eq(catalogModels.providerId, providerId))
}

test('a first sync inserts every discovered model', async () => {
  const provider = await makeProvider()
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'whisper-1'])))

  expect(result.status).toBe('ok')
  expect(result.summary).toEqual({ added: 2, updated: 0, missing: 0, total: 2 })
  expect((await rowsFor(provider.id)).map((r) => r.modelId).sort())
    .toEqual(['gpt-4o', 'whisper-1'])
})

test('registry metadata is merged onto a matched model', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBe('openai/gpt-4o')
  expect(row.kind).toBe('chat')
  expect(row.contextWindow).toBe(128000)
  expect(row.inputPerMtok).toBe('2.500000')
  expect(row.supportsTools).toBe(true)
  expect(row.sources).toMatchObject({ contextWindow: 'registry', kind: 'registry' })
})

test('an unmatched model still lands, classified by the id heuristic', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['whisper-1'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBeNull()
  expect(row.kind).toBe('audio')
  expect(row.contextWindow).toBeNull()
  expect(row.sources).toMatchObject({ kind: 'heuristic' })
})

test('a second sync updates rather than duplicates', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 0, updated: 1, missing: 0, total: 1 })
  expect(await rowsFor(provider.id)).toHaveLength(1)
})

test('a model that stops being returned is marked missing, not deleted', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'gpt-4.5-preview'])))
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 0, updated: 1, missing: 1, total: 1 })
  const rows = await rowsFor(provider.id)
  expect(rows).toHaveLength(2)
  expect(rows.find((r) => r.modelId === 'gpt-4.5-preview')!.status).toBe('missing')
})

test('a model that comes back is available again', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))
  await syncProvider(provider.id, opts(adapterListing([])))
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.status).toBe('available')
})

test('a manual row is never marked missing', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'private-ft', origin: 'manual',
  })

  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  expect(result.summary).toEqual({ added: 1, updated: 0, missing: 0, total: 1 })
  const [manual] = await db.select().from(catalogModels)
    .where(and(eq(catalogModels.providerId, provider.id), eq(catalogModels.modelId, 'private-ft')))
  expect(manual.status).toBe('available')
})

test('a manual row that later appears in discovery becomes discovered', async () => {
  const provider = await makeProvider()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o', origin: 'manual',
    override: { contextWindow: 64000 },
  })

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.origin).toBe('discovered')
  expect(row.override).toEqual({ contextWindow: 64000 })
})

test('overrides survive a re-sync and still win the merge', async () => {
  // Load-bearing: this is the failure that would quietly destroy hand-entered
  // data, and it is the reason overrides live in their own column.
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  await db.update(catalogModels)
    .set({ override: { contextWindow: 64000, inputPerMtok: 9.99 } })
    .where(eq(catalogModels.providerId, provider.id))

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.override).toEqual({ contextWindow: 64000, inputPerMtok: 9.99 })
  expect(row.contextWindow).toBe(64000)
  expect(row.inputPerMtok).toBe('9.990000')
  expect(row.sources).toMatchObject({ contextWindow: 'override', outputPerMtok: 'registry' })
})

test('an adapter with no listModels reports unsupported and writes nothing', async () => {
  const provider = await makeProvider()
  const adapter = { chat: vi.fn(), chatStream: vi.fn() } as unknown as ProviderAdapter

  const result = await syncProvider(provider.id, opts(adapter))

  expect(result.status).toBe('unsupported')
  expect(result.error).toMatch(/cannot list models/i)
  expect(await rowsFor(provider.id)).toHaveLength(0)
})

test('an adapter that does not exist yet reports unsupported', async () => {
  const provider = await makeProvider()
  const result = await syncProvider(provider.id, {
    registry,
    createAdapterImpl: () => { throw new UnsupportedOperationError('the "gemini" adapter is not available yet.') },
  })

  expect(result.status).toBe('unsupported')
})

test('a failed discovery leaves every existing row untouched', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'gpt-4o-mini'])))
  const before = await rowsFor(provider.id)

  const failing = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
  } as unknown as ProviderAdapter

  const result = await syncProvider(provider.id, opts(failing))

  expect(result.status).toBe('failed')
  expect(result.summary).toBeNull()
  expect(await rowsFor(provider.id)).toEqual(before)
})

test('discovery failures are classified into actionable messages', () => {
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 401 })))
    .toMatch(/credentials were rejected/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 403 })))
    .toMatch(/credentials were rejected/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 404 })))
    .toMatch(/no model listing api/i)
  expect(describeDiscoveryError(Object.assign(new Error('x'), { status: 405 })))
    .toMatch(/no model listing api/i)
  expect(describeDiscoveryError(new Error('connect ECONNREFUSED')))
    .toMatch(/ECONNREFUSED/)
})

test('the sync outcome is recorded on the provider row', async () => {
  const provider = await makeProvider()
  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id))
  expect(row.lastSyncStatus).toBe('ok')
  expect(row.lastSyncedAt).toBeInstanceOf(Date)
  expect(row.lastSyncError).toBeNull()
  expect(row.lastSyncSummary).toEqual({ added: 1, updated: 0, missing: 0, total: 1 })
})

test('a failure records its reason on the provider row', async () => {
  const provider = await makeProvider()
  const failing = {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 404 })),
  } as unknown as ProviderAdapter

  await syncProvider(provider.id, opts(failing))

  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id))
  expect(row.lastSyncStatus).toBe('failed')
  expect(row.lastSyncError).toMatch(/no model listing api/i)
  expect(row.lastSyncSummary).toBeNull()
})

test('a configured registry namespace is used for matching', async () => {
  const provider = await db.insert(providers).values({
    name: 'proxy', adapter: 'openai_compatible', baseUrl: 'https://proxy.internal/v1',
    credentials: encryptJson({ apiKey: 'sk-x' }),
    config: JSON.stringify({ registryNamespace: 'openai' }),
  }).returning().then((rows) => rows[0])

  await syncProvider(provider.id, opts(adapterListing(['gpt-4o'])))

  const [row] = await rowsFor(provider.id)
  expect(row.canonicalKey).toBe('openai/gpt-4o')
  expect(row.contextWindow).toBe(128000)
})

test('syncing every provider fetches the registry once', async () => {
  await makeProvider('a')
  await makeProvider('b')
  const adapter = adapterListing(['gpt-4o'])

  const results = await syncAllProviders({ registry, createAdapterImpl: () => adapter })

  expect(results).toHaveLength(2)
  expect(results.every((r) => r.status === 'ok')).toBe(true)
})

test('a provider that vanishes mid-run is reported, not thrown', async () => {
  await expect(
    syncProvider('00000000-0000-0000-0000-000000000000', opts(adapterListing([]))),
  ).rejects.toThrow(/not found/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/catalog/sync.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/sync`.

- [ ] **Step 3: Write the sync module**

Create `src/lib/catalog/sync.ts`:

```ts
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
  if (err instanceof Error && err.name === 'TimeoutError') {
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
    previous ? (updated += 1) : (added += 1)

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
    for (const values of upserts) {
      const { providerId: _p, modelId: _m, ...set } = values
      await tx.insert(catalogModels).values(values).onConflictDoUpdate({
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
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName])
    }
  } finally {
    client.release()
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/sync.test.ts`
Expected: PASS, 18 tests.

If `inputPerMtok` assertions fail on precision, check what Postgres returns for `numeric(12, 6)` — it is `'2.500000'`, not `'2.5'`. Fix the assertion, not the schema.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/sync.ts tests/lib/catalog/sync.test.ts
git commit -m "feat(catalog): provider sync with advisory locking and layered merge"
```

---

### Task 8: Catalog admin module

**Files:**
- Create: `src/lib/admin/catalog.ts`
- Test: `tests/lib/admin/catalog.test.ts`

**Interfaces:**
- Consumes: `catalogModels`, `providers`, `routeTargets` from `@/lib/db/schema`; `mergeCatalogFields` (Task 2); `effectiveColumns` from `@/lib/catalog/sync` (Task 7); `loadRegistry`, `loadSeed`, `canonicalKeyCandidates` for manual rows.
- Produces: `CatalogListItem`, `CatalogFilter`, `PickerModel`, `TargetWarning`, `listCatalog(filter?)`, `listPickerModels(providerId)`, `setOverride(id, patch)`, `clearOverrideField(id, field)`, `addManualModel(input)`, `deleteCatalogModel(id)`, `targetWarnings()` from `@/lib/admin/catalog`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/admin/catalog.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import type { DiscoveredModel, ProviderAdapter } from '@/lib/adapters/types'
import { syncProvider } from '@/lib/catalog/sync'
import type { RegistryLoad } from '@/lib/catalog/registry'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, listCatalog,
  listPickerModels, setOverride, targetWarnings,
} from '@/lib/admin/catalog'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

const registry: RegistryLoad = {
  index: {
    'openai/gpt-4o': {
      kind: 'chat', contextWindow: 128000, maxOutputTokens: 16384,
      inputPerMtok: 2.5, outputPerMtok: 10, cachedInputPerMtok: 1.25,
      supportsTools: true, supportsStreaming: null, modalities: null,
    },
  },
  status: 'cached', url: 'https://models.dev/api.json',
  fetchedAt: new Date('2026-08-12T00:00:00Z'), error: null,
}

async function makeProvider(name = 'openai-prod') {
  const [row] = await db.insert(providers).values({
    name, adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()
  return row
}

function listing(ids: string[]): ProviderAdapter {
  return {
    chat: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue(
      ids.map((id): DiscoveredModel => ({ id, fields: {}, raw: { id } })),
    ),
  } as unknown as ProviderAdapter
}

async function seedCatalog(ids: string[], name = 'openai-prod') {
  const provider = await makeProvider(name)
  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(ids) })
  return provider
}

test('lists every model with its provider name and numeric prices', async () => {
  await seedCatalog(['gpt-4o', 'whisper-1'])
  const items = await listCatalog()

  expect(items.map((i) => i.modelId)).toEqual(['gpt-4o', 'whisper-1'])
  expect(items[0].providerName).toBe('openai-prod')
  // Prices come back as numbers, not the '2.500000' pg returns.
  expect(items[0].inputPerMtok).toBe(2.5)
  expect(items[1].inputPerMtok).toBeNull()
})

test('filters by provider, kind, status and search', async () => {
  const a = await seedCatalog(['gpt-4o', 'whisper-1'], 'a')
  await seedCatalog(['gpt-4o'], 'b')

  expect(await listCatalog({ providerId: a.id })).toHaveLength(2)
  expect((await listCatalog({ kind: 'audio' })).map((i) => i.modelId)).toEqual(['whisper-1'])
  expect((await listCatalog({ search: 'GPT' })).map((i) => i.providerName)).toEqual(['a', 'b'])
  expect(await listCatalog({ status: 'missing' })).toHaveLength(0)
})

test('reports how many route targets still point at a model', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  const [item] = await listCatalog()
  expect(item.routeTargetCount).toBe(1)
})

test('an override is merged in and re-computes the effective columns', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await setOverride(before.id, { contextWindow: 64000 })

  const [after] = await listCatalog()
  expect(after.contextWindow).toBe(64000)
  expect(after.sources.contextWindow).toBe('override')
  // Untouched fields keep inheriting.
  expect(after.inputPerMtok).toBe(2.5)
  expect(after.sources.inputPerMtok).toBe('registry')
})

test('overrides accumulate rather than replacing each other', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()

  await setOverride(row.id, { contextWindow: 64000 })
  await setOverride(row.id, { supportsTools: false })

  const [after] = await listCatalog()
  expect(after.override).toEqual({ contextWindow: 64000, supportsTools: false })
  expect(after.contextWindow).toBe(64000)
  expect(after.supportsTools).toBe(false)
})

test('clearing an override removes the key and falls back to the layer below', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()
  await setOverride(row.id, { contextWindow: 64000, supportsTools: false })

  await clearOverrideField(row.id, 'contextWindow')

  const [after] = await listCatalog()
  expect(after.override).toEqual({ supportsTools: false })
  expect(after.contextWindow).toBe(128000)
  expect(after.sources.contextWindow).toBe('registry')
})

test('a manual model can be added for a provider that cannot be discovered', async () => {
  const provider = await makeProvider()
  await addManualModel({ providerId: provider.id, modelId: 'internal-llm', fields: { contextWindow: 32000 } })

  const [item] = await listCatalog()
  expect(item.origin).toBe('manual')
  expect(item.contextWindow).toBe(32000)
  expect(item.sources.contextWindow).toBe('override')
})

test('a manual model still picks up registry metadata when it matches', async () => {
  const provider = await makeProvider()
  await addManualModel({ providerId: provider.id, modelId: 'gpt-4o' }, { registry })

  const [item] = await listCatalog()
  expect(item.canonicalKey).toBe('openai/gpt-4o')
  expect(item.inputPerMtok).toBe(2.5)
})

test('adding a model that already exists is refused with a clear message', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  await expect(
    addManualModel({ providerId: provider.id, modelId: 'gpt-4o' }),
  ).rejects.toThrow(/already in the catalog/i)
})

test('a blank model id is refused', async () => {
  const provider = await makeProvider()
  await expect(
    addManualModel({ providerId: provider.id, modelId: '   ' }),
  ).rejects.toThrow(/model id is required/i)
})

test('deleting removes the row', async () => {
  await seedCatalog(['gpt-4o'])
  const [row] = await listCatalog()
  await deleteCatalogModel(row.id)
  expect(await listCatalog()).toHaveLength(0)
})

test('the picker groups a provider models chat-first with unknown last', async () => {
  const provider = await seedCatalog(['whisper-1', 'gpt-4o', 'ft:gpt-4o:acme:x2'])
  const groups = await listPickerModels(provider.id)

  expect(groups.map((g) => g.value)).toEqual(['chat', 'audio', 'unknown'])
  expect(groups[0].items.map((i) => i.modelId)).toEqual(['gpt-4o'])
  expect(groups.at(-1)!.items.map((i) => i.modelId)).toEqual(['ft:gpt-4o:acme:x2'])
})

test('the picker carries the context and price it will display', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [chat] = await listPickerModels(provider.id)

  expect(chat.items[0]).toMatchObject({
    modelId: 'gpt-4o', contextWindow: 128000, inputPerMtok: 2.5, outputPerMtok: 10,
    status: 'available',
  })
})

test('a target on a never-synced provider is not called a typo', async () => {
  // On first deploy every target would otherwise look wrong.
  const provider = await makeProvider()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  }).returning()

  expect(await targetWarnings()).toEqual({ [target.id]: 'never_synced' })
})

test('a target naming a model the catalog does not have is flagged', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [typo] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mimi',
  }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  expect(await targetWarnings()).toEqual({ [typo.id]: 'not_in_catalog' })
})

test('a target pointing at a retired model is flagged as missing', async () => {
  const provider = await seedCatalog(['gpt-4o', 'gpt-4.5-preview'])
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4.5-preview',
  }).returning()

  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(['gpt-4o']) })

  expect(await targetWarnings()).toEqual({ [target.id]: 'missing' })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/admin/catalog.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/catalog`.

- [ ] **Step 3: Write the admin module**

Create `src/lib/admin/catalog.ts`:

```ts
import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  catalogModels, providers, routeTargets,
  type CatalogModelRow, type ProviderRow,
} from '@/lib/db/schema'
import { mergeCatalogFields } from '@/lib/catalog/merge'
import { canonicalKeyCandidates } from '@/lib/catalog/normalize'
import { loadRegistry, type RegistryLoad } from '@/lib/catalog/registry'
import { loadSeed } from '@/lib/catalog/seed'
import { effectiveColumns } from '@/lib/catalog/sync'
import type {
  CatalogFields, FieldSources, Modalities, ModelKind,
} from '@/lib/catalog/types'

export interface CatalogListItem {
  id: string
  providerId: string
  providerName: string
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
  routeTargetCount: number,
): CatalogListItem {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName,
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
  }
}

export async function listCatalog(filter: CatalogFilter = {}): Promise<CatalogListItem[]> {
  const conditions = [
    filter.providerId ? eq(catalogModels.providerId, filter.providerId) : undefined,
    filter.kind ? eq(catalogModels.kind, filter.kind) : undefined,
    filter.status ? eq(catalogModels.status, filter.status) : undefined,
  ].filter((c) => c !== undefined)

  const rows = await db
    .select({ model: catalogModels, providerName: providers.name })
    .from(catalogModels)
    .innerJoin(providers, eq(catalogModels.providerId, providers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(providers.name), asc(catalogModels.modelId))

  const targets = await db.select().from(routeTargets)
  const search = filter.search?.trim().toLowerCase()

  return rows
    .filter(({ model }) => !search || model.modelId.toLowerCase().includes(search))
    .map(({ model, providerName }) =>
      toItem(
        model,
        providerName,
        targets.filter(
          (t) => t.providerId === model.providerId && t.upstreamModel === model.modelId,
        ).length,
      ),
    )
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
  const namespace = readNamespace(provider)

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

function readNamespace(provider: ProviderRow): string | null {
  try {
    const parsed = JSON.parse(provider.config) as { registryNamespace?: unknown }
    return typeof parsed.registryNamespace === 'string' ? parsed.registryNamespace : null
  } catch {
    return null
  }
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/admin/catalog.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/catalog.ts tests/lib/admin/catalog.test.ts
git commit -m "feat(catalog): admin queries, overrides, manual rows and target warnings"
```

---

### Task 9: Catalog page

**Files:**
- Create: `src/app/(admin)/catalog/page.tsx`
- Create: `src/app/(admin)/catalog/actions.ts`
- Create: `src/app/(admin)/catalog/catalog-forms.tsx`
- Create: `src/app/(admin)/catalog/sync-buttons.tsx`
- Modify: `src/app/(admin)/layout.tsx:5-10`

**Interfaces:**
- Consumes: everything from `@/lib/admin/catalog` (Task 8); `syncAllProviders` from `@/lib/catalog/sync` (Task 7); `loadRegistry` (Task 4); `getCatalogSettings`, `setCatalogSettings` (Task 4); `listProviders` from `@/lib/admin/providers`.
- Produces: server actions `syncAllAction`, `refreshRegistryAction`, `setOverrideAction`, `clearOverrideAction`, `addManualModelAction`, `deleteCatalogModelAction`, `saveRegistrySettingsAction` from `./actions`; the `/catalog` route.

- [ ] **Step 1: Read the Next docs for this version**

Before writing the page, read the App Router page conventions in `node_modules/next/dist/docs/`. In particular confirm how `searchParams` is typed on a page component in Next 16 — it is a `Promise` that must be awaited, unlike older versions. Match whatever the bundled docs say over anything remembered.

- [ ] **Step 2: Add the nav entry**

In `src/app/(admin)/layout.tsx`, put Catalog second — it reads `Providers → Catalog → Virtual models`:

```ts
const NAV = [
  { href: '/providers', label: 'Providers' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/models', label: 'Virtual models' },
  { href: '/keys', label: 'API keys' },
  { href: '/users', label: 'Users' },
]
```

- [ ] **Step 3: Write the server actions**

Create `src/app/(admin)/catalog/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, setOverride,
} from '@/lib/admin/catalog'
import { setCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { syncAllProviders } from '@/lib/catalog/sync'
import type { CatalogFields } from '@/lib/catalog/types'

export interface ActionState {
  error?: string
  success?: string
}

/** Numeric override fields, parsed from their form values. */
const NUMERIC_FIELDS = [
  'contextWindow', 'maxOutputTokens', 'inputPerMtok', 'outputPerMtok',
  'cachedInputPerMtok',
] as const satisfies readonly (keyof CatalogFields)[]

function overrideFrom(formData: FormData): Partial<CatalogFields> {
  const patch: Partial<CatalogFields> = {}

  for (const field of NUMERIC_FIELDS) {
    const raw = formData.get(field)
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number.`)
    }
    patch[field] = value
  }

  for (const field of ['supportsTools', 'supportsStreaming'] as const) {
    const raw = formData.get(field)
    if (raw === 'true') patch[field] = true
    else if (raw === 'false') patch[field] = false
  }

  const kind = formData.get('kind')
  if (typeof kind === 'string' && kind !== '') patch.kind = kind as CatalogFields['kind']

  return patch
}

export async function syncAllAction(): Promise<void> {
  await requireAdmin()
  await syncAllProviders()
  revalidatePath('/catalog')
  revalidatePath('/providers')
}

export async function refreshRegistryAction(): Promise<void> {
  await requireAdmin()
  await loadRegistry({ force: true })
  revalidatePath('/catalog')
}

export async function setOverrideAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setOverride(String(formData.get('id')), overrideFrom(formData))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the override.' }
  }
  revalidatePath('/catalog')
  return { success: 'Override saved.' }
}

export async function clearOverrideAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await clearOverrideField(
    String(formData.get('id')),
    String(formData.get('field')) as keyof CatalogFields,
  )
  revalidatePath('/catalog')
}

export async function addManualModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await addManualModel({
      providerId: String(formData.get('providerId')),
      modelId: String(formData.get('modelId') ?? ''),
      fields: overrideFrom(formData),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not add the model.' }
  }
  revalidatePath('/catalog')
  return { success: 'Model added.' }
}

export async function deleteCatalogModelAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteCatalogModel(String(formData.get('id')))
  revalidatePath('/catalog')
}

export async function saveRegistrySettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setCatalogSettings({
      registryEnabled: formData.get('registryEnabled') === 'on',
      registryUrl: String(formData.get('registryUrl') ?? ''),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }
  revalidatePath('/catalog')
  return { success: 'Registry settings saved.' }
}
```

- [ ] **Step 4: Write the client forms**

Create `src/app/(admin)/catalog/catalog-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { CatalogListItem } from '@/lib/admin/catalog'
import {
  addManualModelAction, saveRegistrySettingsAction, setOverrideAction,
  type ActionState,
} from './actions'

function Message({ state }: { state: ActionState | undefined }) {
  if (state?.error) return <p role="alert" className="text-sm text-destructive">{state.error}</p>
  if (state?.success) return <p className="text-sm text-muted-foreground">{state.success}</p>
  return null
}

const NUMERIC_LABELS = [
  ['contextWindow', 'Context window'],
  ['maxOutputTokens', 'Max output tokens'],
  ['inputPerMtok', 'Input $/Mtok'],
  ['outputPerMtok', 'Output $/Mtok'],
  ['cachedInputPerMtok', 'Cached input $/Mtok'],
] as const

export function OverrideForm({ item }: { item: CatalogListItem }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    setOverrideAction, undefined,
  )

  return (
    <form action={action} className="space-y-3 pt-2">
      <input type="hidden" name="id" value={item.id} />
      <div className="grid gap-3 sm:grid-cols-3">
        {NUMERIC_LABELS.map(([field, label]) => (
          <div key={field} className="space-y-1">
            <Label htmlFor={`${item.id}-${field}`} className="text-xs">{label}</Label>
            <Input
              id={`${item.id}-${field}`}
              name={field}
              type="number"
              step="any"
              min="0"
              defaultValue={item.override[field] ?? ''}
              placeholder={item[field] === null ? '—' : String(item[field])}
            />
            <p className="text-xs text-muted-foreground">
              {item.sources[field] ? `now from ${item.sources[field]}` : 'not known'}
            </p>
          </div>
        ))}
      </div>
      <Message state={state} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Saving…' : 'Save override'}
      </Button>
    </form>
  )
}

export function AddManualModelForm({
  providers,
}: {
  providers: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    addManualModelAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor="manual-provider" className="text-xs">Provider</Label>
        <select
          id="manual-provider"
          name="providerId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="manual-model" className="text-xs">Model id</Label>
        <Input id="manual-model" name="modelId" required placeholder="internal-llm-v2" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="manual-context" className="text-xs">Context window</Label>
        <Input id="manual-context" name="contextWindow" type="number" min="0" className="w-32" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Adding…' : 'Add model'}
      </Button>
      <div className="w-full"><Message state={state} /></div>
    </form>
  )
}

export function RegistrySettingsForm({
  registryEnabled,
  registryUrl,
  fetchedAt,
  status,
}: {
  registryEnabled: boolean
  registryUrl: string
  fetchedAt: Date | null
  status: string
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    saveRegistrySettingsAction, undefined,
  )

  return (
    <form action={action} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">Model registry</h2>
      <div className="flex items-center gap-2">
        <Switch id="registryEnabled" name="registryEnabled" defaultChecked={registryEnabled} />
        <Label htmlFor="registryEnabled">Enrich the catalog from an external registry</Label>
      </div>
      <div className="space-y-1">
        <Label htmlFor="registryUrl" className="text-xs">Registry URL</Label>
        <Input id="registryUrl" name="registryUrl" defaultValue={registryUrl} className="max-w-lg" />
      </div>
      <p className="text-sm text-muted-foreground">
        {fetchedAt
          ? `Last fetched ${fetchedAt.toISOString()} (${status}).`
          : 'Never fetched — the catalog is using the bundled snapshot.'}
      </p>
      <Message state={state} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 5: Write the sync buttons**

Create `src/app/(admin)/catalog/sync-buttons.tsx`:

```tsx
'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { refreshRegistryAction, syncAllAction } from './actions'

export function SyncAllButton() {
  const [pending, start] = useTransition()

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => start(async () => {
        await syncAllAction()
        toast.success('Sync complete.')
      })}
    >
      {pending ? 'Syncing…' : 'Sync all'}
    </Button>
  )
}

export function RefreshRegistryButton() {
  const [pending, start] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => start(async () => {
        await refreshRegistryAction()
        toast.success('Registry refreshed.')
      })}
    >
      {pending ? 'Refreshing…' : 'Refresh registry'}
    </Button>
  )
}
```

- [ ] **Step 6: Write the page**

Create `src/app/(admin)/catalog/page.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listCatalog, type CatalogListItem } from '@/lib/admin/catalog'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { getCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { modelKinds, type ModelKind } from '@/lib/catalog/types'
import { deleteCatalogModelAction } from './actions'
import { AddManualModelForm, OverrideForm, RegistrySettingsForm } from './catalog-forms'
import { RefreshRegistryButton, SyncAllButton } from './sync-buttons'

export const dynamic = 'force-dynamic'

function money(value: number | null) {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

function context(value: number | null) {
  if (value === null) return '—'
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function StatusCell({ item }: { item: CatalogListItem }) {
  if (item.status === 'missing') {
    return (
      <Badge variant="destructive">
        {item.routeTargetCount > 0
          ? `missing — ${item.routeTargetCount} target(s) still point here`
          : 'missing'}
      </Badge>
    )
  }
  if (item.origin === 'manual') return <Badge variant="outline">manual</Badge>
  return <Badge variant="secondary">available</Badge>
}

export default async function CatalogPage({
  searchParams,
}: {
  // Next 16 passes searchParams as a promise. Confirm against
  // node_modules/next/dist/docs/ before changing this signature.
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const params = await searchParams

  const providerId = typeof params.provider === 'string' ? params.provider : undefined
  const kind = typeof params.kind === 'string' ? (params.kind as ModelKind) : undefined
  const search = typeof params.q === 'string' ? params.q : undefined

  const [items, providers, settings, registry] = await Promise.all([
    listCatalog({ providerId, kind, search }),
    listProviders(),
    getCatalogSettings(),
    loadRegistry(),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Catalog</h1>
        <div className="ml-auto flex gap-2">
          <RefreshRegistryButton />
          <SyncAllButton />
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-2">
        <Input name="q" defaultValue={search ?? ''} placeholder="Search model id" className="w-64" />
        <select
          name="provider"
          defaultValue={providerId ?? ''}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          name="kind"
          defaultValue={kind ?? ''}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All kinds</option>
          {modelKinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Button type="submit" size="sm" variant="outline">Filter</Button>
      </form>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1">Model</th><th>Provider</th><th>Kind</th>
            <th>Context</th><th>In/out</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t align-top">
              <td className="py-2">
                <details>
                  <summary className="cursor-pointer font-mono text-xs">{item.modelId}</summary>
                  <div className="space-y-2 py-2">
                    <p className="text-xs text-muted-foreground">
                      {item.canonicalKey
                        ? `Matched ${item.canonicalKey}`
                        : 'No registry match — set a registry namespace on the provider, or override the fields below.'}
                    </p>
                    <OverrideForm item={item} />
                  </div>
                </details>
              </td>
              <td>{item.providerName}</td>
              <td>{item.kind}</td>
              <td>{context(item.contextWindow)}</td>
              <td>{money(item.inputPerMtok)}/{money(item.outputPerMtok)}</td>
              <td><StatusCell item={item} /></td>
              <td className="text-right">
                <form action={deleteCatalogModelAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {items.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-3 text-muted-foreground">
                Nothing here yet — sync a provider, or add a model by hand.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {providers.length > 0 ? <AddManualModelForm providers={providers} /> : null}

      <RegistrySettingsForm
        registryEnabled={settings.registryEnabled}
        registryUrl={settings.registryUrl}
        fetchedAt={registry.fetchedAt}
        status={registry.error ?? registry.status}
      />
    </div>
  )
}
```

A deleted discovered row returns on the next sync with its override gone. Add that to the Delete button's surrounding copy if a confirmation dialog is introduced later; for now the page's empty-state copy and this note in the plan are the record of it.

- [ ] **Step 7: Verify the page renders and the suite still passes**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
pnpm build
```

Expected: all clean, `/catalog` present in the build output's route list.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(admin\)/catalog src/app/\(admin\)/layout.tsx
git commit -m "feat(catalog): catalog page with filters, overrides, manual models and registry settings"
```

---

### Task 10: Provider sync controls and credential editing

**Files:**
- Modify: `src/lib/admin/providers.ts` (`ProviderListItem`, `listProviders`)
- Modify: `src/app/(admin)/providers/actions.ts`
- Modify: `src/app/(admin)/providers/page.tsx`
- Create: `src/app/(admin)/providers/sync-provider-button.tsx`
- Create: `src/app/(admin)/providers/edit-provider-form.tsx`
- Test: `tests/lib/admin/providers.test.ts` (append)

**Interfaces:**
- Consumes: `syncProvider` from `@/lib/catalog/sync` (Task 7); existing `updateProvider` from `@/lib/admin/providers`.
- Produces: `ProviderListItem` extended with `catalogModelCount`, `registryNamespace`, `lastSyncedAt`, `lastSyncStatus`, `lastSyncError`, `lastSyncSummary`; server actions `syncProviderAction`, `updateProviderAction`.

This task closes the Phase 1 handoff's most urgent gap: today, rotating a leaked API key means deleting every route target and recreating the provider, because `updateProvider` is implemented and tested but nothing calls it except the enable/disable toggle.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/admin/providers.test.ts`:

```ts
test('listProviders reports catalog counts and sync bookkeeping', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
    config: { registryNamespace: 'openai' },
  })
  await db.insert(catalogModels).values([
    { providerId: provider.id, modelId: 'gpt-4o' },
    { providerId: provider.id, modelId: 'gpt-4o-mini' },
  ])
  await db.update(providers).set({
    lastSyncedAt: new Date('2026-08-12T09:00:00Z'),
    lastSyncStatus: 'ok',
    lastSyncSummary: { added: 2, updated: 0, missing: 0, total: 2 },
  }).where(eq(providers.id, provider.id))

  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(2)
  expect(item.registryNamespace).toBe('openai')
  expect(item.lastSyncStatus).toBe('ok')
  expect(item.lastSyncSummary).toEqual({ added: 2, updated: 0, missing: 0, total: 2 })
})

test('a provider with no catalog rows reports zero, not undefined', async () => {
  await createProvider({ name: 'fresh', adapter: 'openai', credentials: { apiKey: 'sk-x' } })
  const [item] = await listProviders()
  expect(item.catalogModelCount).toBe(0)
  expect(item.lastSyncedAt).toBeNull()
  expect(item.registryNamespace).toBeNull()
})
```

Add `catalogModels` and `eq` to that file's existing imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: FAIL — `catalogModelCount` is undefined.

- [ ] **Step 3: Extend listProviders**

In `src/lib/admin/providers.ts`, extend the interface:

```ts
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
  lastSyncedAt: Date | null
  lastSyncStatus: 'ok' | 'failed' | 'unsupported' | null
  lastSyncError: string | null
  lastSyncSummary: { added: number; updated: number; missing: number; total: number } | null
}
```

Replace `listProviders`. This also closes a handoff item — the old version counted route targets in JS by scanning the full table per provider:

```ts
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
    lastSyncedAt: row.lastSyncedAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    lastSyncSummary: row.lastSyncSummary ?? null,
  }))
}

function readRegistryNamespace(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { registryNamespace?: unknown }
    return typeof parsed.registryNamespace === 'string' ? parsed.registryNamespace : null
  } catch {
    return null
  }
}
```

Extend the imports: `count` from `drizzle-orm`, and `catalogModels` from `@/lib/db/schema`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Add the server actions**

Append to `src/app/(admin)/providers/actions.ts`:

```ts
export async function syncProviderAction(id: string): Promise<void> {
  await requireAdmin()
  await syncProvider(id)
  revalidatePath('/providers')
  revalidatePath('/catalog')
}

export async function updateProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const id = String(formData.get('id'))
  const rawAdapter = String(formData.get('adapter'))
  if (!(adapterTypes as readonly string[]).includes(rawAdapter)) {
    return { error: `Unknown adapter: ${rawAdapter}` }
  }
  const adapter = rawAdapter as AdapterType

  const credentials = credentialsFrom(formData, adapter)
  const namespace = String(formData.get('registryNamespace') ?? '').trim()

  try {
    await updateProvider(id, {
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      // An empty credential form means "keep what is stored" — the browser is
      // never sent the current secret, so a blank field cannot mean "erase".
      ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
      config: namespace ? { registryNamespace: namespace } : {},
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not update the provider.' }
  }

  // Credentials may have changed; refresh what this provider can serve.
  await syncProvider(id)

  revalidatePath('/providers')
  revalidatePath('/catalog')
  return { success: 'Provider updated.' }
}
```

Add `syncProvider` from `@/lib/catalog/sync` to the imports.

- [ ] **Step 6: Write the sync button**

Create `src/app/(admin)/providers/sync-provider-button.tsx`:

```tsx
'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { syncProviderAction } from './actions'

export function SyncProviderButton({ id }: { id: string }) {
  const [pending, start] = useTransition()

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => start(async () => {
        await syncProviderAction(id)
        toast.success('Sync finished.')
      })}
    >
      {pending ? 'Syncing…' : 'Sync models'}
    </Button>
  )
}
```

- [ ] **Step 7: Write the credential edit form**

Create `src/app/(admin)/providers/edit-provider-form.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProviderListItem } from '@/lib/admin/providers'
import { updateProviderAction, type ActionState } from './actions'

const CREDENTIAL_FIELDS: Record<string, string[]> = {
  openai: ['apiKey', 'organization', 'project'],
  openai_compatible: ['apiKey', 'organization', 'project'],
  gemini: ['apiKey'],
  bedrock: ['region', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
}

export function EditProviderForm({ provider }: { provider: ProviderListItem }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateProviderAction, undefined,
  )

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">Edit</summary>
      <form action={action} className="space-y-3 py-3">
        <input type="hidden" name="id" value={provider.id} />
        <input type="hidden" name="adapter" value={provider.adapter} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`name-${provider.id}`} className="text-xs">Name</Label>
            <Input id={`name-${provider.id}`} name="name" defaultValue={provider.name} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`baseUrl-${provider.id}`} className="text-xs">Base URL</Label>
            <Input
              id={`baseUrl-${provider.id}`}
              name="baseUrl"
              defaultValue={provider.baseUrl ?? ''}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ns-${provider.id}`} className="text-xs">Registry namespace</Label>
            <Input
              id={`ns-${provider.id}`}
              name="registryNamespace"
              defaultValue={provider.registryNamespace ?? ''}
              placeholder="groq"
            />
            <p className="text-xs text-muted-foreground">
              models.dev namespace for enriching this provider&apos;s models.
            </p>
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-xs text-muted-foreground">
            Credentials — leave blank to keep the stored values.
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(CREDENTIAL_FIELDS[provider.adapter] ?? []).map((field) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`${field}-${provider.id}`} className="text-xs">{field}</Label>
                <Input
                  id={`${field}-${provider.id}`}
                  name={field}
                  type={field.toLowerCase().includes('key') || field === 'sessionToken'
                    ? 'password'
                    : 'text'}
                  autoComplete="off"
                  placeholder={provider.maskedCredentials[field] ?? ''}
                />
              </div>
            ))}
          </div>
        </fieldset>

        {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        {state?.success ? <p className="text-sm text-muted-foreground">{state.success}</p> : null}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save and re-sync'}
        </Button>
      </form>
    </details>
  )
}
```

- [ ] **Step 8: Wire both into the providers page**

In `src/app/(admin)/providers/page.tsx`, add a `Models` column between `Targets` and `Status`, add the sync control, and render the edit form. Replace the `<th>` row and the provider `<tr>`:

```tsx
          <tr>
            <th className="py-2">Name</th>
            <th>Adapter</th>
            <th>Credentials</th>
            <th>Targets</th>
            <th>Models</th>
            <th>Status</th>
            <th>Test connection</th>
            <th />
          </tr>
```

```tsx
            <tr key={provider.id} className="border-t align-top">
              <td className="py-2 font-medium">
                {provider.name}
                <EditProviderForm provider={provider} />
              </td>
              <td>{provider.adapter}</td>
              <td className="font-mono text-xs">
                {Object.entries(provider.maskedCredentials)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' ')}
              </td>
              <td>{provider.targetCount}</td>
              <td>
                <a href={`/catalog?provider=${provider.id}`} className="underline">
                  {provider.catalogModelCount}
                </a>
                <div className="text-xs text-muted-foreground">
                  <SyncStatus provider={provider} />
                </div>
              </td>
              <td>
                <Badge variant={provider.enabled ? 'default' : 'secondary'}>
                  {provider.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </td>
              <td>
                <TestProviderButton providerId={provider.id} />
              </td>
              <td className="text-right whitespace-nowrap">
                <SyncProviderButton id={provider.id} />
                <ToggleProviderButton id={provider.id} enabled={provider.enabled} />
                <DeleteProviderButton id={provider.id} />
              </td>
            </tr>
```

Add the status helper above the page component, and bump the empty-state `colSpan` to 8:

```tsx
function SyncStatus({ provider }: { provider: ProviderListItem }) {
  if (!provider.lastSyncedAt) return <>never synced</>

  const when = provider.lastSyncedAt.toISOString()
  if (provider.lastSyncStatus === 'ok' && provider.lastSyncSummary) {
    const { added, updated, missing } = provider.lastSyncSummary
    return <>synced {when} · +{added} new ~{updated} updated{missing > 0 ? ` !${missing} missing` : ''}</>
  }
  return <span className="text-destructive">{provider.lastSyncStatus}: {provider.lastSyncError}</span>
}
```

Import `SyncProviderButton`, `EditProviderForm`, and the `ProviderListItem` type.

- [ ] **Step 9: Verify and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build
```

```bash
git add src/lib/admin/providers.ts src/app/\(admin\)/providers tests/lib/admin/providers.test.ts
git commit -m "feat(catalog): per-provider sync controls and a real credential edit form"
```

---

### Task 11: Model picker, editable route targets, and unknown-model warnings

**Files:**
- Modify: `src/lib/admin/models.ts` (add `updateRouteTarget`)
- Modify: `src/app/(admin)/models/actions.ts`
- Modify: `src/app/(admin)/models/page.tsx`
- Modify: `src/app/(admin)/models/model-form.tsx`
- Create: `src/app/(admin)/models/model-combobox.tsx`
- Create: `src/app/(admin)/models/edit-target-form.tsx`
- Test: `tests/lib/admin/models.test.ts` (append)

**Interfaces:**
- Consumes: `listPickerModels`, `PickerGroup`, `targetWarnings`, `TargetWarning` from `@/lib/admin/catalog` (Task 8).
- Produces: `updateRouteTarget(id, input)` from `@/lib/admin/models`; `updateTargetAction` from `./actions`; the `ModelCombobox` client component.

- [ ] **Step 1: Read the Base UI autocomplete docs**

Read `node_modules/@base-ui/react/docs/react/components/autocomplete.md`, specifically the **Grouped** example. The API used below — `items` as an array of `{ value, items }` group objects, `<Autocomplete.List>` taking a render function over groups, and `<Autocomplete.Collection>` over each group's items — comes from that file. Autocomplete (not Combobox) is the right primitive here precisely because it permits arbitrary typed values.

- [ ] **Step 2: Write the failing test for updateRouteTarget**

Append to `tests/lib/admin/models.test.ts` (matching that file's existing setup and imports):

```ts
test('a route target can be edited in place', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mimi',
  })

  const updated = await updateRouteTarget(target.id, {
    upstreamModel: 'gpt-4o-mini', priority: 5, weight: 50,
  })

  expect(updated.upstreamModel).toBe('gpt-4o-mini')
  expect(updated.priority).toBe(5)
  expect(updated.weight).toBe(50)
})

test('editing only one field leaves the others alone', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id,
    upstreamModel: 'gpt-4o', priority: 3, weight: 70,
  })

  const updated = await updateRouteTarget(target.id, { weight: 90 })
  expect(updated.upstreamModel).toBe('gpt-4o')
  expect(updated.priority).toBe(3)
  expect(updated.weight).toBe(90)
})

test('an edit is validated the same way an insert is', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  await expect(updateRouteTarget(target.id, { upstreamModel: '  ' }))
    .rejects.toThrow(/upstream model name is required/i)
  await expect(updateRouteTarget(target.id, { weight: 0 }))
    .rejects.toThrow(/positive integer/i)
  await expect(updateRouteTarget(target.id, { priority: 1.5 }))
    .rejects.toThrow(/integer/i)
})

test('editing a target that does not exist is refused', async () => {
  await expect(
    updateRouteTarget('00000000-0000-0000-0000-000000000000', { weight: 10 }),
  ).rejects.toThrow(/not found/i)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test tests/lib/admin/models.test.ts`
Expected: FAIL — `updateRouteTarget` is not exported.

- [ ] **Step 4: Implement updateRouteTarget**

In `src/lib/admin/models.ts`, add after `addRouteTarget`. Validation is factored out so an edit and an insert can never drift apart:

```ts
function validateTargetFields(input: {
  upstreamModel?: string
  priority?: number
  weight?: number
}) {
  const patch: { upstreamModel?: string; priority?: number; weight?: number } = {}

  if (input.upstreamModel !== undefined) {
    const upstreamModel = input.upstreamModel.trim()
    if (!upstreamModel) throw new Error('An upstream model name is required.')
    patch.upstreamModel = upstreamModel
  }
  if (input.weight !== undefined) {
    if (!Number.isInteger(input.weight) || input.weight < 1) {
      throw new Error('Target weight must be a positive integer.')
    }
    patch.weight = input.weight
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority)) {
      throw new Error('Target priority must be an integer.')
    }
    patch.priority = input.priority
  }

  return patch
}

export async function updateRouteTarget(
  id: string,
  input: { upstreamModel?: string; priority?: number; weight?: number; enabled?: boolean },
): Promise<RouteTargetRow> {
  const patch: Record<string, unknown> = validateTargetFields(input)
  if (input.enabled !== undefined) patch.enabled = input.enabled

  const [row] = await db.update(routeTargets).set(patch)
    .where(eq(routeTargets.id, id)).returning()
  if (!row) throw new Error('Route target not found.')
  return row
}
```

Rewrite `addRouteTarget`'s validation to use the same helper, so the two paths share one definition:

```ts
export async function addRouteTarget(input: RouteTargetInput): Promise<RouteTargetRow> {
  const validated = validateTargetFields({
    upstreamModel: input.upstreamModel,
    priority: input.priority ?? 0,
    weight: input.weight ?? 100,
  })

  const [row] = await db.insert(routeTargets).values({
    virtualModelId: input.virtualModelId,
    providerId: input.providerId,
    upstreamModel: validated.upstreamModel!,
    priority: validated.priority!,
    weight: validated.weight!,
    enabled: input.enabled ?? true,
  }).returning()
  return row
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/lib/admin/models.test.ts`
Expected: PASS, including the four new tests and every pre-existing one.

- [ ] **Step 6: Write the combobox**

Create `src/app/(admin)/models/model-combobox.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import type { PickerGroup, PickerModel } from '@/lib/admin/catalog'

function detail(model: PickerModel) {
  const parts: string[] = []
  if (model.contextWindow !== null) {
    parts.push(model.contextWindow >= 1000
      ? `${Math.round(model.contextWindow / 1000)}k`
      : String(model.contextWindow))
  }
  if (model.inputPerMtok !== null && model.outputPerMtok !== null) {
    parts.push(`$${model.inputPerMtok.toFixed(2)}/$${model.outputPerMtok.toFixed(2)}`)
  }
  if (model.status === 'missing') parts.push('missing upstream')
  return parts.join(' · ')
}

/**
 * A combobox, not a select: anything typed is saveable. The catalog is
 * advisory, so an unrecognised value warns rather than blocking.
 */
export function ModelCombobox({
  name,
  id,
  groups,
  defaultValue = '',
}: {
  name: string
  id: string
  groups: PickerGroup[]
  defaultValue?: string
}) {
  const [value, setValue] = useState(defaultValue)

  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.modelId)))
  const unrecognised = value.trim().length > 0 && !known.has(value.trim())

  return (
    <div className="space-y-1">
      <Autocomplete.Root
        items={groups}
        value={value}
        onValueChange={setValue}
        itemToStringValue={(item: PickerModel) => item.modelId}
      >
        <Autocomplete.Input
          id={id}
          name={name}
          required
          placeholder="gpt-4o-mini"
          className="h-9 w-56 rounded-md border bg-transparent px-3 text-sm"
        />

        <Autocomplete.Portal>
          <Autocomplete.Positioner sideOffset={4} className="outline-hidden">
            <Autocomplete.Popup className="max-h-80 w-(--anchor-width) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              <Autocomplete.Empty className="px-2 py-3 text-sm text-muted-foreground">
                Nothing in the catalog matches — you can still type any model name.
              </Autocomplete.Empty>

              <Autocomplete.List>
                {(group: PickerGroup) => (
                  <Autocomplete.Group key={group.value} items={group.items} className="block pb-1">
                    <Autocomplete.GroupLabel className="px-2 py-1 text-xs text-muted-foreground select-none">
                      {group.value}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(model: PickerModel) => (
                        <Autocomplete.Item
                          key={model.id}
                          value={model}
                          className="flex cursor-default items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        >
                          <span className="font-mono text-xs">{model.modelId}</span>
                          <span className="text-xs text-muted-foreground">{detail(model)}</span>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>

      {unrecognised ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Not in the catalog — saving anyway is fine.
        </p>
      ) : null}
    </div>
  )
}
```

If the `items`/render-function shape differs from the bundled docs, follow the docs. Do not change the free-text contract: `Autocomplete.Input` must carry `name` so the typed value is what the form submits, whether or not an item was picked.

- [ ] **Step 7: Wire the picker into the add-target form**

In `src/app/(admin)/models/model-form.tsx`, change `AddTargetForm`'s props to carry per-provider catalog groups, and select the groups for whichever provider is chosen:

```tsx
export function AddTargetForm({
  virtualModelId,
  providers,
  groupsByProvider,
}: {
  virtualModelId: string
  providers: Array<{ id: string; name: string }>
  groupsByProvider: Record<string, PickerGroup[]>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    addTargetAction, undefined,
  )
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 pt-2">
      <input type="hidden" name="virtualModelId" value={virtualModelId} />
      <div className="space-y-1">
        <Label htmlFor={`provider-${virtualModelId}`} className="text-xs">Provider</Label>
        <select
          id={`provider-${virtualModelId}`}
          name="providerId"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`upstream-${virtualModelId}`} className="text-xs">Upstream model</Label>
        <ModelCombobox
          id={`upstream-${virtualModelId}`}
          name="upstreamModel"
          groups={groupsByProvider[providerId] ?? []}
        />
      </div>
      {/* priority and weight inputs are unchanged */}
      <Button type="submit" size="sm" disabled={pending}>Add target</Button>
      {state?.error ? <p role="alert" className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  )
}
```

Add `useState` to the React import, plus imports for `ModelCombobox` and the `PickerGroup` type.

- [ ] **Step 8: Add the edit-target form and action**

Append to `src/app/(admin)/models/actions.ts`:

```ts
export async function updateTargetAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await updateRouteTarget(String(formData.get('id')), {
      upstreamModel: String(formData.get('upstreamModel') ?? ''),
      priority: Number(formData.get('priority') ?? 0),
      weight: Number(formData.get('weight') ?? 100),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not update the target.' }
  }
  revalidatePath('/models')
  return { success: 'Target updated.' }
}
```

Add `updateRouteTarget` to that file's import from `@/lib/admin/models`.

Create `src/app/(admin)/models/edit-target-form.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PickerGroup } from '@/lib/admin/catalog'
import { ModelCombobox } from './model-combobox'
import { updateTargetAction, type ActionState } from './actions'

export function EditTargetForm({
  target,
  groups,
}: {
  target: { id: string; upstreamModel: string; priority: number; weight: number }
  groups: PickerGroup[]
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateTargetAction, undefined,
  )

  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">Edit</summary>
      <form action={action} className="flex flex-wrap items-end gap-2 py-2">
        <input type="hidden" name="id" value={target.id} />
        <div className="space-y-1">
          <Label htmlFor={`edit-model-${target.id}`} className="text-xs">Upstream model</Label>
          <ModelCombobox
            id={`edit-model-${target.id}`}
            name="upstreamModel"
            groups={groups}
            defaultValue={target.upstreamModel}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-priority-${target.id}`} className="text-xs">Priority</Label>
          <Input
            id={`edit-priority-${target.id}`} name="priority" type="number"
            defaultValue={target.priority} className="w-24"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-weight-${target.id}`} className="text-xs">Weight</Label>
          <Input
            id={`edit-weight-${target.id}`} name="weight" type="number"
            defaultValue={target.weight} className="w-24"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state?.error ? <p role="alert" className="w-full text-sm text-destructive">{state.error}</p> : null}
      </form>
    </details>
  )
}
```

- [ ] **Step 9: Show warnings on existing targets**

In `src/app/(admin)/models/page.tsx`, load the picker groups and warnings alongside the existing data:

```tsx
  const [models, providers, warnings] = await Promise.all([
    listVirtualModels(), listProviders(), targetWarnings(),
  ])

  const groupsByProvider = Object.fromEntries(
    await Promise.all(
      providers.map(async (provider) => [provider.id, await listPickerModels(provider.id)] as const),
    ),
  )
```

Add a warning badge to the upstream-model cell, and the edit form to each target row:

```tsx
                  <td className="font-mono text-xs">
                    {target.upstreamModel}
                    <TargetWarningBadge warning={warnings[target.id]} />
                    <EditTargetForm
                      target={target}
                      groups={groupsByProvider[target.providerId] ?? []}
                    />
                  </td>
```

Add the badge helper above the page component. The `never_synced` case is what stops a first deploy from showing a wall of false typos:

```tsx
function TargetWarningBadge({ warning }: { warning: TargetWarning | undefined }) {
  if (!warning) return null
  if (warning === 'never_synced') {
    return <Badge variant="outline" className="ml-2">provider not synced yet</Badge>
  }
  if (warning === 'missing') {
    return <Badge variant="destructive" className="ml-2">retired upstream</Badge>
  }
  return <Badge variant="destructive" className="ml-2">not in catalog</Badge>
}
```

Pass `groupsByProvider` into `<AddTargetForm />`, and import `listPickerModels`, `targetWarnings` and the `TargetWarning` type from `@/lib/admin/catalog` plus `EditTargetForm`.

- [ ] **Step 10: Verify and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build
```

Then run the app and check the picker by hand — this is the one piece no test covers:

```bash
pnpm dev
```

Confirm at `http://localhost:3000/models`: the picker groups chat first and unknown last, typing a name absent from the catalog still saves and shows the amber warning, and editing an existing target persists.

```bash
git add src/lib/admin/models.ts src/app/\(admin\)/models tests/lib/admin/models.test.ts
git commit -m "feat(catalog): model picker, editable route targets and unknown-model warnings"
```

---

### Task 12: Catalog-to-route shortcut, docs, and final verification

**Files:**
- Modify: `src/app/(admin)/catalog/actions.ts`
- Modify: `src/app/(admin)/catalog/catalog-forms.tsx`
- Modify: `src/app/(admin)/catalog/page.tsx`
- Modify: `README.md`
- Test: `tests/lib/admin/catalog.test.ts` (append)

**Interfaces:**
- Consumes: `addRouteTarget`, `createVirtualModel`, `listVirtualModels` from `@/lib/admin/models`.
- Produces: `routeToModelAction` from `./actions`; `RouteToModelForm` from `./catalog-forms`.

The shortcut is a second entry point into `addRouteTarget`, never a parallel implementation — every validation and default stays in one place.

- [ ] **Step 1: Write the contract test**

This one is not TDD — the behaviour it covers already exists. It is a
**contract test**: it pins the defaults the shortcut inherits from
`addRouteTarget`, so a later change to those defaults breaks here rather than
silently changing what the shortcut creates. Write it, run it, and expect it to
pass on the first run. Do not manufacture a failing state for it.

Append to `tests/lib/admin/catalog.test.ts`:

```ts
test('routing from a catalog row reuses addRouteTarget', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()

  await addRouteTarget({
    virtualModelId: model.id,
    providerId: item.providerId,
    upstreamModel: item.modelId,
  })

  const targets = await db.select().from(routeTargets)
  expect(targets).toHaveLength(1)
  expect(targets[0].upstreamModel).toBe('gpt-4o')
  expect(targets[0].weight).toBe(100)

  // The catalog now reports the reference, which drives the "still routed" badge.
  const [after] = await listCatalog()
  expect(after.routeTargetCount).toBe(1)
})
```

Add `addRouteTarget` to that file's imports from `@/lib/admin/models`.

- [ ] **Step 2: Run it to verify it passes**

Run: `pnpm test tests/lib/admin/catalog.test.ts`
Expected: PASS on the first run, including the new test. A failure here means
`addRouteTarget`'s defaults are not what the shortcut assumes — investigate
rather than adjusting the assertion to match.

- [ ] **Step 4: Add the shortcut action**

Append to `src/app/(admin)/catalog/actions.ts`:

```ts
export async function routeToModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()

  const providerId = String(formData.get('providerId'))
  const upstreamModel = String(formData.get('modelId') ?? '')
  const existingId = String(formData.get('virtualModelId') ?? '')
  const newName = String(formData.get('newModelName') ?? '').trim()

  try {
    let virtualModelId = existingId
    if (!virtualModelId) {
      if (!newName) throw new Error('Pick a virtual model, or name a new one.')
      const created = await createVirtualModel({ name: newName })
      virtualModelId = created.id
    }

    await addRouteTarget({ virtualModelId, providerId, upstreamModel })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the route.' }
  }

  revalidatePath('/catalog')
  revalidatePath('/models')
  return { success: 'Route created.' }
}
```

Add `addRouteTarget` and `createVirtualModel` from `@/lib/admin/models` to the imports.

- [ ] **Step 5: Add the shortcut form**

Append to `src/app/(admin)/catalog/catalog-forms.tsx`:

```tsx
export function RouteToModelForm({
  item,
  virtualModels,
}: {
  item: CatalogListItem
  virtualModels: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    routeToModelAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t pt-3">
      <input type="hidden" name="providerId" value={item.providerId} />
      <input type="hidden" name="modelId" value={item.modelId} />

      <div className="space-y-1">
        <Label htmlFor={`route-${item.id}`} className="text-xs">Route to</Label>
        <select
          id={`route-${item.id}`}
          name="virtualModelId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">— new virtual model —</option>
          {virtualModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`route-name-${item.id}`} className="text-xs">New name</Label>
        <Input id={`route-name-${item.id}`} name="newModelName" placeholder="house-model" />
      </div>

      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Creating…' : 'Route to this'}
      </Button>
      <div className="w-full"><Message state={state} /></div>
    </form>
  )
}
```

Add `routeToModelAction` to that file's import from `./actions`.

- [ ] **Step 6: Render it in the catalog row**

In `src/app/(admin)/catalog/page.tsx`, load the virtual models and pass them down. Extend the `Promise.all`:

```tsx
  const [items, providers, settings, registry, virtualModels] = await Promise.all([
    listCatalog({ providerId, kind, search }),
    listProviders(),
    getCatalogSettings(),
    loadRegistry(),
    listVirtualModels(),
  ])
```

Inside each row's `<details>`, after `<OverrideForm item={item} />`:

```tsx
                    <RouteToModelForm
                      item={item}
                      virtualModels={virtualModels.map((m) => ({ id: m.id, name: m.name }))}
                    />
```

Import `listVirtualModels` from `@/lib/admin/models` and `RouteToModelForm` from `./catalog-forms`.

- [ ] **Step 7: Update the README**

In `README.md`, add a Model catalog section after the local-development section, and remove the catalog-shaped entries from "Not yet implemented" if any are listed there:

```markdown
## Model catalog

The **Catalog** page lists every model each provider actually serves. It is
populated by asking providers directly — `GET /v1/models` for `openai` and
`openai_compatible` — and enriched from three further layers, resolved field by
field with the first non-null value winning:

| Layer | Source |
|---|---|
| Override | Anything you edit in the dashboard. Always wins, and survives every re-sync. |
| Discovered | What the provider reported. OpenAI-shaped endpoints report only a model id. |
| Registry | [models.dev](https://models.dev), fetched at most daily and cached in the database. Toggleable, for deployments without egress. |
| Seed | A models.dev snapshot vendored into the repo, so a first boot with no network still has context windows and prices. Refresh with `pnpm seed:refresh`. |

Syncing is explicit: a **Sync models** button per provider, **Sync all** on the
catalog page, and an automatic sync when a provider is created or its
credentials are edited. Nothing runs on a timer.

The catalog is advisory. Route targets remain free text — the picker suggests
models and warns about names it does not recognise, but never blocks a save, and
the gateway request path never reads the catalog. A model that stops being
returned is marked *missing* rather than deleted, so a provider having a bad day
cannot quietly erase your catalog or the overrides on it.

`openai_compatible` providers can set a **registry namespace** (`groq`,
`openrouter`, …) so their models match models.dev entries. Ollama has no
models.dev namespace, so those models stay unenriched unless you override them
by hand.
```

- [ ] **Step 8: Final verification**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

Expected: all four clean. Do not claim completion until every one has been run and its output seen — a passing `tsc` is not evidence that `build` passes, and neither is evidence about the tests.

Then exercise it against a real provider:

```bash
pnpm dev
```

1. Create or edit an OpenAI provider with a real key; confirm the sync fires and the catalog fills.
2. Confirm `whisper-1`, `tts-1` and `dall-e-3` land in non-chat groups, and that `text-embedding-3-small` is classified `embedding`.
3. Override a context window, re-sync, and confirm the override survived.
4. Point a provider at a URL with no `/v1/models` and confirm the failure message names that specifically rather than saying "Invalid input".

- [ ] **Step 9: Commit**

```bash
git add src/app/\(admin\)/catalog README.md tests/lib/admin/catalog.test.ts
git commit -m "feat(catalog): route-to-this shortcut and catalog documentation"
```

---

## Plan self-review

Checked after writing, against `docs/superpowers/specs/2026-08-12-model-catalog-design.md`.

**Spec coverage.** Every section maps to a task: §4 data model → Task 1; §5 `merge()` → Task 2, `normalize()` → Task 3, adapter interface → Task 6; §6 sync → Task 7; §7 dashboard → Tasks 9–12; §8 failure modes → Tasks 4, 7, 9; §9 testing → distributed across every task. §10's note that `/v1/models` stays client-facing and Phase-3-scoped needs no task; it is a statement about what this phase does *not* do.

**Three spec corrections are folded into Task 1 Step 1** rather than left as drift: Bedrock ids keep their region prefix and `-v1:0` suffix in models.dev, canonical keys are namespaced by provider slug, and `kind` gains `video`. These were found by inspecting the live document, not derived from the spec.

**Type consistency.** `CatalogFields` (Task 2) is the single shape crossing every boundary: adapters produce it (`DiscoveredModel.fields`), the registry projection produces it (`RegistryIndex`), the override column stores it, and `mergeCatalogFields` consumes all four. `effectiveColumns` is defined once in Task 7 and exported for reuse in Task 8, so the merge-to-column mapping cannot drift between sync and override edits. `validateTargetFields` in Task 11 does the same for insert versus update.

**Known sharp edges, flagged rather than hidden:**

- `numeric(12, 6)` round-trips as a string (`'2.500000'`), which is why `money()` exists in Task 7 and `toNumber()` in Task 8. Task 7 Step 4 says explicitly to fix the assertion, not the schema, if precision surprises you.
- The advisory lock must be taken on a dedicated pooled connection, because session-scoped locks do not survive drizzle handing you a different connection per statement. Task 7 does this and says why.
- The Base UI autocomplete shape in Task 11 is transcribed from the bundled docs at `node_modules/@base-ui/react/docs/react/components/autocomplete.md`. If it differs, follow the docs — but keep `name` on `Autocomplete.Input`, which is what preserves the free-text contract.
- The vendored seed is ~1.6 MB and regenerating it produces a large diff. That is expected for a generated file.
