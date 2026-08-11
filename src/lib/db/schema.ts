import {
  boolean, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

export const adapterEnum = pgEnum('adapter', [
  'openai', 'openai_compatible', 'gemini', 'bedrock',
])

export const policyEnum = pgEnum('routing_policy', [
  'failover', 'weighted', 'round_robin',
])

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  adapter: adapterEnum('adapter').notNull(),
  baseUrl: text('base_url'),
  credentials: text('credentials').notNull(),
  config: text('config').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
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

export type ProviderRow = typeof providers.$inferSelect
export type VirtualModelRow = typeof virtualModels.$inferSelect
export type RouteTargetRow = typeof routeTargets.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type UserRow = typeof users.$inferSelect
