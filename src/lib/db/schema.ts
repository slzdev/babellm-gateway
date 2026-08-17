import {
  bigint, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique,
  uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core'
import { SERVICE_TIERS } from '@/lib/service-tiers'

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

export const apiFlavorEnum = pgEnum('api_flavor', ['chat_completions', 'responses'])

export const serviceTierEnum = pgEnum('service_tier', SERVICE_TIERS)

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  adapter: adapterEnum('adapter').notNull(),
  baseUrl: text('base_url'),
  credentials: text('credentials').notNull(),
  config: text('config').notNull().default('{}'),
  // Dead: the gateway speaks Chat Completions to every OpenAI-shaped provider
  // and nothing reads this column any more. Kept declared — with the enum
  // above — only so drizzle does not generate a DROP that a deployment still
  // running the previous release would break on. Delete both in a later
  // migration, once no live deployment predates that removal.
  apiFlavor: apiFlavorEnum('api_flavor').notNull().default('chat_completions'),
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
  // Nullable with no default, because NULL is a distinct behaviour rather than
  // a missing value: it means the gateway forwards the client's body untouched.
  serviceTier: serviceTierEnum('service_tier'),
  // Nullable with no default: NULL means "inherit the global", and 0 is a
  // distinct, meaningful value — "never open this target" — so a default
  // would make the two indistinguishable.
  breakerThreshold: integer('breaker_threshold'),
  breakerCooldownSeconds: integer('breaker_cooldown_seconds'),
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

export const requestOutcomeEnum = pgEnum('request_outcome', [
  'ok', 'error', 'client_closed', 'stream_interrupted',
])

/** One attempt against one route target. Structural, so schema.ts stays free
 * of a dependency on the routing loop and the OpenAI SDK. Mirrors
 * AttemptRecord in src/lib/gateway/execute.ts. */
type LoggedAttempt = {
  n: number
  targetId: string
  provider: string
  model: string
  status: number
  latencyMs: number
  error?: string
}

/** The per-Mtok rates used to price this request, snapshotted so a later
 * catalog price edit cannot make historical arithmetic unexplainable. */
type LoggedPricing = {
  inputPerMtok: string | null
  cachedInputPerMtok: string | null
  outputPerMtok: string | null
}

export const requestLogs = pgTable(
  'request_logs',
  {
    // v7, minted at request start rather than defaulted at insert: the same
    // value is the client's x-request-id and the partition key. A column
    // default would mint it too late to be either. Ordering by it is
    // therefore by request start, while created_at records completion.
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // set null, not cascade: a deleted key must not erase the history of what
    // it did. key_name is denormalized for the same reason.
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    keyName: text('key_name'),

    // What the client asked for — a virtual model name or a direct
    // `provider/model` address. Deliberately not a virtual_models FK: a direct
    // address resolves to a catalog row, so the key would point at the wrong
    // table half the time.
    model: varchar('model', { length: 128 }),

    stream: boolean('stream').notNull().default(false),
    status: integer('status').notNull(),
    outcome: requestOutcomeEnum('outcome').notNull(),
    errorType: text('error_type'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    latencyMs: integer('latency_ms').notNull(),
    ttftMs: integer('ttft_ms'),
    attempts: jsonb('attempts').$type<LoggedAttempt[]>().notNull().default([]),

    finalTargetId: uuid('final_target_id'),
    finalProviderId: uuid('final_provider_id'),
    finalProvider: text('final_provider'),
    finalUpstreamModel: varchar('final_upstream_model', { length: 128 }),

    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    cachedTokens: integer('cached_tokens'),
    reasoningTokens: integer('reasoning_tokens'),

    // scale 9, not 6: a small request can cost less than a micro-dollar, and
    // rounding that to 0.000000 is the silent-zero lie in another disguise.
    inputCostUsd: numeric('input_cost_usd', { precision: 18, scale: 9 }),
    cachedCostUsd: numeric('cached_cost_usd', { precision: 18, scale: 9 }),
    outputCostUsd: numeric('output_cost_usd', { precision: 18, scale: 9 }),
    costUsd: numeric('cost_usd', { precision: 18, scale: 9 }),
    pricing: jsonb('pricing').$type<LoggedPricing | null>(),

    droppedParams: jsonb('dropped_params').$type<string[]>(),
    payloadCaptured: boolean('payload_captured').notNull().default(false),

    // Inline rather than a second table. A separate payloads table needs a
    // foreign key pointing *at* request_logs, and an inbound foreign key makes
    // a partition undroppable — which would defeat partitioning entirely.
    // Postgres gives each partition its own TOAST relation, so a large body is
    // already stored out of line and is only read when the column is selected.
    requestJson: jsonb('request_json').$type<unknown>(),
    responseJson: jsonb('response_json').$type<unknown>(),
    payloadTruncated: boolean('payload_truncated').notNull().default(false),
  },
  (table) => [
    index('request_logs_api_key_idx').on(table.apiKeyId, table.id.desc()),
    index('request_logs_model_idx').on(table.model, table.id.desc()),
  ],
)

/** The same three classes `conditions()` in src/lib/logs/postgres.ts derives
 * from `status`, and the same three values as the StatusClass union in
 * src/lib/logs/types.ts. An error rate on the dashboard and a status filter
 * on /logs must mean the same thing; naming them identically in both places
 * is what keeps that true. */
export const statusClassEnum = pgEnum('status_class', [
  'success', 'client_error', 'server_error',
])

/**
 * Hourly pre-aggregation of request_logs, one row per
 * (hour, key, user, model, provider, status class) that actually occurred.
 *
 * Row count grows with distinct traffic shapes per hour, not with request
 * volume — which is the whole point. Reading this table is how the dashboard
 * avoids scanning a log table that grows forever.
 *
 * Never dropped. dropExpiredPartitions() deletes raw logs past the retention
 * window; usage and spend history outlives them here.
 */
export const usageRollups = pgTable(
  'usage_rollups',
  {
    /** Hour start, UTC. Derived from the request's uuid v7 id (its start),
     * never from created_at (its completion) — see the spec §5.2. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),

    // Deliberately NOT a foreign key. `ON DELETE SET NULL` — what
    // request_logs uses — would collide two deleted keys' rows on the unique
    // constraint below and make deleting an API key throw. `ON DELETE
    // CASCADE` would destroy spend history, which request_logs' own comment
    // forbids. So: a plain uuid recording a historical fact, with the name
    // denormalized beside it.
    apiKeyId: uuid('api_key_id'),
    keyName: text('key_name'),

    // Resolved through api_keys at rollup time and then frozen. Reassigning a
    // key to another user changes future buckets and leaves past ones alone:
    // those requests really were made under the old owner.
    userId: uuid('user_id'),
    userName: text('user_name'),

    model: varchar('model', { length: 128 }),
    provider: text('provider'),
    statusClass: statusClassEnum('status_class').notNull(),

    requests: integer('requests').notNull(),
    /** Requests whose cost_usd was NULL. sum(cost_usd) over unpriced requests
     * reads as "$0 spent"; the logs page refuses that lie by rendering
     * "unpriced", and this column is how the dashboard refuses it too. */
    unpricedRequests: integer('unpriced_requests').notNull(),

    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull(),
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull(),

    // Scale 9 matches request_logs exactly. Re-rounding here would
    // reintroduce one layer up the silent zero that column avoids.
    inputCostUsd: numeric('input_cost_usd', { precision: 18, scale: 9 }).notNull(),
    cachedCostUsd: numeric('cached_cost_usd', { precision: 18, scale: 9 }).notNull(),
    outputCostUsd: numeric('output_cost_usd', { precision: 18, scale: 9 }).notNull(),
    costUsd: numeric('cost_usd', { precision: 18, scale: 9 }).notNull(),

    // latency_count is redundant with `requests` today — latency_ms is
    // NOT NULL, so every request contributes to both — but it is still
    // tracked as its own column so the average is well-defined without a
    // reader needing to know that, and so latency and ttft carry a matching
    // shape: sum, max, count. ttft_count is not redundant: ttft_ms is null
    // for every non-streaming request, so dividing both sums by one count
    // would drag average TTFT toward zero in proportion to non-streaming
    // traffic.
    latencySumMs: bigint('latency_sum_ms', { mode: 'number' }).notNull(),
    latencyMaxMs: integer('latency_max_ms').notNull(),
    latencyCount: integer('latency_count').notNull(),
    ttftSumMs: bigint('ttft_sum_ms', { mode: 'number' }).notNull(),
    ttftCount: integer('ttft_count').notNull(),
  },
  (table) => [
    // NULLS NOT DISTINCT (Postgres 15+) is load-bearing: api_key_id, model
    // and provider are all nullable, and by default Postgres considers two
    // NULLs distinct — so without it this constraint would not constrain the
    // rows that need it most, and duplicate buckets would accumulate
    // invisibly, inflating every total on the page.
    unique('usage_rollups_grain_key')
      .on(
        table.bucket, table.apiKeyId, table.userId,
        table.model, table.provider, table.statusClass,
      )
      .nullsNotDistinct(),
    index('usage_rollups_bucket_idx').on(table.bucket),
    index('usage_rollups_key_bucket_idx').on(table.apiKeyId, table.bucket),
    index('usage_rollups_user_bucket_idx').on(table.userId, table.bucket),
    index('usage_rollups_model_bucket_idx').on(table.model, table.bucket),
  ],
)

export type ProviderRow = typeof providers.$inferSelect
export type VirtualModelRow = typeof virtualModels.$inferSelect
export type RouteTargetRow = typeof routeTargets.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type UserRow = typeof users.$inferSelect
export type CatalogModelRow = typeof catalogModels.$inferSelect
export type RegistryCacheRow = typeof registryCache.$inferSelect
export type SettingRow = typeof settings.$inferSelect
export type RequestLogRow = typeof requestLogs.$inferSelect
export type UsageRollupRow = typeof usageRollups.$inferSelect
