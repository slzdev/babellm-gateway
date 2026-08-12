import {
  boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

export const adapterEnum = pgEnum('adapter', [
  'openai', 'openai_compatible', 'gemini', 'bedrock',
])

export const policyEnum = pgEnum('routing_policy', [
  'failover', 'weighted', 'round_robin',
])

export const catalogOriginEnum = pgEnum('catalog_origin', ['discovered', 'manual'])

export const catalogStatusEnum = pgEnum('catalog_status', ['available', 'missing'])

export const modelKindEnum = pgEnum('model_kind', [
  'chat', 'embedding', 'image', 'audio', 'video', 'unknown',
])

export const syncStatusEnum = pgEnum('sync_status', ['ok', 'failed', 'unsupported'])

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  adapter: adapterEnum('adapter').notNull(),
  baseUrl: text('base_url'),
  credentials: text('credentials').notNull(),
  config: text('config').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncStatus: syncStatusEnum('last_sync_status'),
  lastSyncError: text('last_sync_error'),
  lastSyncSummary: jsonb('last_sync_summary').$type<{
    added: number; updated: number; missing: number; total: number
    // Optional because rows written before match counting existed have no
    // count, and must not be read as "matched nothing".
    matched?: number
  } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const virtualModels = pgTable('virtual_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  policy: policyEnum('policy').notNull().default('failover'),
  maxAttempts: integer('max_attempts').notNull().default(3),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const routeTargets = pgTable('route_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  virtualModelId: uuid('virtual_model_id')
    .notNull()
    .references(() => virtualModels.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  upstreamModel: text('upstream_model').notNull(),
  priority: integer('priority').notNull().default(0),
  weight: integer('weight').notNull().default(100),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
    budgetTotalUsd: numeric('budget_total_usd', { precision: 12, scale: 6 }),
    budgetMonthlyUsd: numeric('budget_monthly_usd', { precision: 12, scale: 6 }),
    spendTotalUsd: numeric('spend_total_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    logPayloads: boolean('log_payloads').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('api_keys_key_hash_idx').on(table.keyHash)],
)

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

export type ProviderRow = typeof providers.$inferSelect
export type VirtualModelRow = typeof virtualModels.$inferSelect
export type RouteTargetRow = typeof routeTargets.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type UserRow = typeof users.$inferSelect
export type CatalogModelRow = typeof catalogModels.$inferSelect
export type RegistryCacheRow = typeof registryCache.$inferSelect
export type SettingRow = typeof settings.$inferSelect
