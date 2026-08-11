# BabeLLM Gateway — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working OpenAI-compatible gateway that authenticates a virtual API key, routes to a single configured provider target, and serves `/v1/chat/completions` with streaming and tool calling — plus the admin dashboard needed to configure it.

**Architecture:** One Next.js app with two disjoint surfaces. The gateway (`/v1/*`) is plain route handlers with no React and no session auth. The dashboard (`/(admin)/*`) uses Server Components reading Drizzle directly and Server Actions for mutations. They share only `lib/db` and `lib/crypto`. The OpenAI wire format is the internal contract — a zod-parsed request object is handed straight to a `ProviderAdapter`.

**Tech Stack:** Next.js 16.3 (App Router) · React 19.2 · TypeScript strict · Drizzle ORM 0.45 + `pg` 8.23 · PostgreSQL 17 · zod 4.4 · Tailwind v4 + shadcn/ui · vitest 4.1 · pnpm · `openai` 7.4

**Spec:** `docs/superpowers/specs/2026-08-11-babellm-gateway-design.md`

## Global Constraints

- **PostgreSQL only.** One Drizzle schema, one migration set. No SQLite, no dual-dialect code.
- **Node runtime.** Every gateway route handler declares `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`. No edge runtime anywhere.
- **All shared state lives in Postgres.** No module-level mutable state that a second instance would not see.
- **Secrets never leave the server.** Provider credentials are AES-256-GCM encrypted at rest and are never returned to the browser after creation — only a masked suffix.
- **The gateway never imports from the dashboard, and vice versa.** Shared code goes in `lib/db` or `lib/crypto` only.
- **Response identity:** every chat response reports the *virtual* model name and a gateway-generated `chatcmpl-…` id. Never leak the upstream model in the body — it goes in `x-babellm-upstream-model`.
- **Errors are always the OpenAI envelope:** `{"error":{"message","type","param","code"}}`.
- **Unknown request parameters are forwarded to the provider**, not stripped. This is what makes provider extensions (xAI's `search_parameters`) work.
- **Package versions are pinned to the values in Tech Stack above.** Do not upgrade or downgrade during implementation.
- **TDD, always.** Write the failing test, watch it fail, implement, watch it pass, commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `docker-compose.yml` | Local Postgres 17 |
| `drizzle.config.ts` | Migration generation config |
| `vitest.config.ts` | Test runner config, `@/` alias |
| `tests/setup/global-setup.ts` | Creates + migrates the test database once |
| `tests/setup/env.ts` | Loads `.env.test` before tests |
| `tests/helpers/db.ts` | `testDb()`, `resetDb()` |
| `tests/helpers/sse.ts` | Parses an SSE body into chunk objects |
| `src/lib/crypto.ts` | AES-256-GCM `encryptJson` / `decryptJson` |
| `src/lib/db/schema.ts` | All Drizzle tables and enums |
| `src/lib/db/index.ts` | Pool + `db` singleton |
| `src/lib/schemas/chat.ts` | zod contract for the OpenAI chat request |
| `src/lib/gateway/errors.ts` | `GatewayError`, error envelope, provider error classification |
| `src/lib/gateway/auth.ts` | Key generation, hashing, resolution |
| `src/lib/gateway/identity.ts` | Response id/model rewriting |
| `src/lib/gateway/resolve.ts` | Virtual model → candidate target lookup |
| `src/lib/gateway/execute.ts` | Adapter invocation and the streaming commit boundary |
| `src/lib/adapters/types.ts` | `ProviderAdapter`, `AttemptContext`, `UnsupportedOperationError` |
| `src/lib/adapters/registry.ts` | adapter enum → factory |
| `src/lib/adapters/openai/index.ts` | OpenAI + openai-compatible adapter |
| `src/app/v1/chat/completions/route.ts` | Gateway ingress |
| `src/lib/admin/session.ts` | Signed session cookie, `requireAdmin()` |
| `src/app/login/page.tsx` | Login form |
| `src/app/(admin)/layout.tsx` | Admin shell, auth gate |
| `src/app/(admin)/providers/` | Provider CRUD page + actions |
| `src/app/(admin)/models/` | Virtual model + route target CRUD |
| `src/app/(admin)/keys/` | API key CRUD |
| `src/app/(admin)/users/` | User label CRUD |

---

## Task 1: Project scaffold, Postgres, and the test harness

**Files:**
- Create: `package.json`, `docker-compose.yml`, `.env.example`, `.env`, `.env.test`, `drizzle.config.ts`, `vitest.config.ts`, `tests/setup/env.ts`, `tests/smoke.test.ts`
- Create: the Next.js app skeleton under `src/`

**Interfaces:**
- Consumes: nothing
- Produces: a working `pnpm test`, `pnpm dev`, and a Postgres reachable at `DATABASE_URL`

- [ ] **Step 1: Scaffold Next.js into a subdirectory and move it up**

`create-next-app` refuses to run in a directory containing `docs/`, so scaffold beside it and move the result in.

```bash
cd /Users/slz/Code/slz/babellm-gateway
pnpm create next-app@latest scaffold-tmp \
  --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --yes
rsync -a --exclude '.git' scaffold-tmp/ ./
rm -rf scaffold-tmp
```

- [ ] **Step 2: Pin dependencies**

```bash
pnpm add next@16.3.0 react@19.2.8 react-dom@19.2.8 \
  drizzle-orm@0.45.2 pg@8.23.0 zod@4.4.3 openai@7.4.0
pnpm add -D drizzle-kit@0.31.10 vitest@4.1.10 dotenv@17.2.3 \
  @types/pg@8.21.0 @types/node@22.15.3 tsx@4.20.6
```

- [ ] **Step 3: Add scripts to `package.json`**

Replace the `scripts` block with:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

- [ ] **Step 4: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: babellm
      POSTGRES_PASSWORD: babellm
      POSTGRES_DB: babellm
    ports:
      - "5433:5432"
    volumes:
      - babellm-pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U babellm"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  babellm-pg:
```

Port 5433 avoids colliding with any Postgres already running on 5432.

- [ ] **Step 5: Write `.env.example`**

```bash
# Postgres connection string
DATABASE_URL=postgres://babellm:babellm@localhost:5433/babellm

# 32-byte key, hex encoded. Generate with: openssl rand -hex 32
ENCRYPTION_KEY=

# Dashboard password (single shared admin password)
ADMIN_PASSWORD=

# Secret used to sign the admin session cookie. openssl rand -hex 32
SESSION_SECRET=
```

- [ ] **Step 6: Create `.env` and `.env.test` with real generated values**

```bash
KEY=$(openssl rand -hex 32); SESSION=$(openssl rand -hex 32)
cat > .env <<EOF
DATABASE_URL=postgres://babellm:babellm@localhost:5433/babellm
ENCRYPTION_KEY=$KEY
ADMIN_PASSWORD=devpassword
SESSION_SECRET=$SESSION
EOF
sed 's#/babellm$#/babellm_test#' .env > .env.test
```

Confirm `.gitignore` contains `.env*` and `!.env.example`.

- [ ] **Step 7: Start Postgres and verify it accepts connections**

```bash
docker compose up -d
docker compose exec postgres pg_isready -U babellm
```

Expected: `accepting connections`

- [ ] **Step 8: Write `drizzle.config.ts`**

```ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 9: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup/env.ts'],
    globalSetup: ['./tests/setup/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
})
```

- [ ] **Step 10: Write `tests/setup/env.ts`**

```ts
import { config } from 'dotenv'

config({ path: '.env.test', override: true })
```

- [ ] **Step 11: Write a placeholder `tests/setup/global-setup.ts`**

Task 3 replaces the body with real migration logic. For now it only creates the database so the harness runs.

```ts
import { config } from 'dotenv'
import { Client } from 'pg'

export default async function setup() {
  config({ path: '.env.test', override: true })
  const url = new URL(process.env.DATABASE_URL!)
  const dbName = url.pathname.slice(1)

  const adminUrl = new URL(url.toString())
  adminUrl.pathname = '/postgres'
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  const { rowCount } = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  )
  if (!rowCount) await client.query(`CREATE DATABASE "${dbName}"`)
  await client.end()
}
```

- [ ] **Step 12: Write the smoke test**

```ts
// tests/smoke.test.ts
import { expect, test } from 'vitest'
import { Client } from 'pg'

test('the test database is reachable', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const { rows } = await client.query('SELECT 1 AS ok')
  await client.end()
  expect(rows[0].ok).toBe(1)
})
```

- [ ] **Step 13: Run the smoke test**

Run: `pnpm test`
Expected: PASS, 1 test.

- [ ] **Step 14: Verify the dev server boots**

Run: `pnpm dev` and open `http://localhost:3000`
Expected: the default Next.js page renders. Stop the server.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app, Postgres, and test harness"
```

---

## Task 2: Encrypted credential storage

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `tests/lib/crypto.test.ts`

**Interfaces:**
- Consumes: `ENCRYPTION_KEY` env (64 hex chars)
- Produces:
  - `encryptJson(value: unknown): string`
  - `decryptJson<T>(blob: string): T`
  - Both throw `Error` on a missing or malformed key, and `decryptJson` throws on tampered ciphertext.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/crypto.test.ts
import { beforeEach, describe, expect, test } from 'vitest'
import { decryptJson, encryptJson } from '@/lib/crypto'

describe('crypto', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  })

  test('round-trips an object', () => {
    const value = { apiKey: 'sk-secret', organization: 'org-1' }
    expect(decryptJson(encryptJson(value))).toEqual(value)
  })

  test('produces a different ciphertext each time (random IV)', () => {
    const a = encryptJson({ apiKey: 'x' })
    const b = encryptJson({ apiKey: 'x' })
    expect(a).not.toBe(b)
  })

  test('uses the versioned four-part format', () => {
    expect(encryptJson({ a: 1 }).split('.')).toHaveLength(4)
    expect(encryptJson({ a: 1 }).startsWith('v1.')).toBe(true)
  })

  test('rejects a tampered ciphertext', () => {
    const blob = encryptJson({ apiKey: 'x' })
    const parts = blob.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(() => decryptJson(parts.join('.'))).toThrow()
  })

  test('rejects an unknown format version', () => {
    expect(() => decryptJson('v9.a.b.c')).toThrow(/unsupported/i)
  })

  test('rejects a key of the wrong length', () => {
    process.env.ENCRYPTION_KEY = 'abc'
    expect(() => encryptJson({ a: 1 })).toThrow(/64 hex/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/crypto.test.ts`
Expected: FAIL — cannot resolve `@/lib/crypto`.

- [ ] **Step 3: Implement `src/lib/crypto.ts`**

```ts
import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32',
    )
  }
  return Buffer.from(raw, 'hex')
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptJson<T>(blob: string): T {
  const [version, iv, tag, ciphertext] = blob.split('.')
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version: ${version}`)
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
}
```

- [ ] **Step 4: Install `server-only` and run the tests**

```bash
pnpm add server-only@0.0.1
pnpm test tests/lib/crypto.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts tests/lib/crypto.test.ts package.json pnpm-lock.yaml
git commit -m "feat: AES-256-GCM credential encryption"
```

---

## Task 3: Database schema and migrations

**Files:**
- Create: `src/lib/db/schema.ts`, `src/lib/db/index.ts`, `tests/helpers/db.ts`
- Modify: `tests/setup/global-setup.ts`
- Test: `tests/lib/db/schema.test.ts`

**Interfaces:**
- Consumes: `encryptJson` / `decryptJson` from Task 2
- Produces:
  - Tables `providers`, `users`, `apiKeys`, `virtualModels`, `routeTargets`
  - `adapterEnum` values `openai | openai_compatible | gemini | bedrock`
  - `policyEnum` values `failover | weighted | round_robin`
  - `db` — the Drizzle instance
  - `testDb()`, `resetDb()` helpers

Phase 1 creates only the tables Phase 1 uses. `target_health`, `rr_cursors`, `request_logs`, `request_payloads`, `key_usage_monthly`, `rate_windows`, `model_prices` and `settings` arrive in Phases 2 and 4 as additive migrations.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/db/schema.test.ts
import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, providers, routeTargets, users, virtualModels } from '@/lib/db/schema'
import { encryptJson, decryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('a provider round-trips with encrypted credentials', async () => {
  const [row] = await db
    .insert(providers)
    .values({
      name: 'openai-prod',
      adapter: 'openai',
      credentials: encryptJson({ apiKey: 'sk-test' }),
    })
    .returning()

  expect(row.enabled).toBe(true)
  expect(row.credentials).not.toContain('sk-test')
  expect(decryptJson<{ apiKey: string }>(row.credentials).apiKey).toBe('sk-test')
})

test('provider names are unique', async () => {
  await db.insert(providers).values({
    name: 'dupe', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  })
  await expect(
    db.insert(providers).values({
      name: 'dupe', adapter: 'openai', credentials: encryptJson({ apiKey: 'b' }),
    }),
  ).rejects.toThrow()
})

test('a route target joins a virtual model to a provider', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()

  await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o-mini',
    priority: 0,
    weight: 100,
  })

  const rows = await db.select().from(routeTargets).where(eq(routeTargets.virtualModelId, model.id))
  expect(rows).toHaveLength(1)
  expect(rows[0].upstreamModel).toBe('gpt-4o-mini')
  expect(model.policy).toBe('failover')
  expect(model.maxAttempts).toBe(3)
})

test('deleting a virtual model cascades to its targets', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'fast' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mini',
  })

  await db.delete(virtualModels).where(eq(virtualModels.id, model.id))
  expect(await db.select().from(routeTargets)).toHaveLength(0)
})

test('an api key can exist without a user, and key_hash is unique', async () => {
  await db.insert(apiKeys).values({ name: 'k1', keyHash: 'h1', keyPrefix: 'sk-bab-aaaa' })
  await expect(
    db.insert(apiKeys).values({ name: 'k2', keyHash: 'h1', keyPrefix: 'sk-bab-bbbb' }),
  ).rejects.toThrow()
})

test('deleting a user leaves its keys with a null user_id', async () => {
  const [user] = await db.insert(users).values({ name: 'Ada' }).returning()
  await db.insert(apiKeys).values({
    name: 'k', keyHash: 'h', keyPrefix: 'sk-bab-cccc', userId: user.id,
  })
  await db.delete(users).where(eq(users.id, user.id))
  const [key] = await db.select().from(apiKeys)
  expect(key.userId).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/db/schema.test.ts`
Expected: FAIL — cannot resolve `@/lib/db`.

- [ ] **Step 3: Write `src/lib/db/schema.ts`**

```ts
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
```

`config` is `text` holding JSON rather than `jsonb` because it is only ever read and written whole, and text keeps the column symmetrical with the encrypted `credentials` blob beside it.

- [ ] **Step 4: Write `src/lib/db/index.ts`**

```ts
import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

declare global {
  // eslint-disable-next-line no-var
  var __babellmPool: Pool | undefined
}

const pool =
  globalThis.__babellmPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 20 })

if (process.env.NODE_ENV !== 'production') globalThis.__babellmPool = pool

export const db = drizzle(pool, { schema })
export { pool, schema }
```

The global cache keeps Next.js dev hot-reloads from opening a new pool on every edit.

- [ ] **Step 5: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: a file appears under `drizzle/` and the migration applies cleanly.

- [ ] **Step 6: Replace `tests/setup/global-setup.ts` so it migrates the test database**

```ts
import { config } from 'dotenv'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

export default async function setup() {
  config({ path: '.env.test', override: true })
  const url = new URL(process.env.DATABASE_URL!)
  const dbName = url.pathname.slice(1)

  const adminUrl = new URL(url.toString())
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  )
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`)
  await admin.end()

  const pool = new Pool({ connectionString: url.toString() })
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
  await pool.end()
}
```

- [ ] **Step 7: Write `tests/helpers/db.ts`**

```ts
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

const TABLES = ['route_targets', 'virtual_models', 'api_keys', 'users', 'providers']

export async function resetDb() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )
}

export { db as testDb }
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test tests/lib/db/schema.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: database schema, migrations, and test db helpers"
```

---
## Task 4: The OpenAI chat request contract

**Files:**
- Create: `src/lib/schemas/chat.ts`
- Test: `tests/lib/schemas/chat.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `chatCompletionRequestSchema` — a zod schema
  - `type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>`

The schema must be **loose**: unknown top-level keys survive parsing so provider extensions pass through untouched. Only fields the gateway itself reads (`model`, `stream`, `stream_options`, `messages`) need precise typing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/schemas/chat.test.ts
import { expect, test } from 'vitest'
import { chatCompletionRequestSchema } from '@/lib/schemas/chat'

const minimal = { model: 'fast', messages: [{ role: 'user', content: 'hi' }] }

test('accepts a minimal request', () => {
  const parsed = chatCompletionRequestSchema.parse(minimal)
  expect(parsed.model).toBe('fast')
  expect(parsed.stream).toBeUndefined()
})

test('rejects a request with no model', () => {
  expect(() => chatCompletionRequestSchema.parse({ messages: [] })).toThrow()
})

test('rejects an empty messages array', () => {
  expect(() =>
    chatCompletionRequestSchema.parse({ model: 'fast', messages: [] }),
  ).toThrow()
})

test('accepts multimodal content parts', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
      ],
    }],
  })
  expect(Array.isArray(parsed.messages[0].content)).toBe(true)
})

test('accepts tools, tool_choice, and an assistant tool_calls turn', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'fast',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
    tool_choice: 'auto',
  })
  expect(parsed.tools?.[0].function.name).toBe('get_weather')
})

test('accepts a named tool_choice', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  })
  expect(parsed.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
})

test('preserves unknown provider-specific parameters', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    search_parameters: { mode: 'auto' },
  }) as Record<string, unknown>
  expect(parsed.search_parameters).toEqual({ mode: 'auto' })
})

test('accepts streaming with usage requested', () => {
  const parsed = chatCompletionRequestSchema.parse({
    ...minimal,
    stream: true,
    stream_options: { include_usage: true },
  })
  expect(parsed.stream).toBe(true)
  expect(parsed.stream_options?.include_usage).toBe(true)
})

test('rejects a non-boolean stream flag', () => {
  expect(() =>
    chatCompletionRequestSchema.parse({ ...minimal, stream: 'yes' }),
  ).toThrow()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/schemas/chat.test.ts`
Expected: FAIL — cannot resolve `@/lib/schemas/chat`.

- [ ] **Step 3: Implement `src/lib/schemas/chat.ts`**

```ts
import { z } from 'zod'

const textPart = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
})

const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
})

const contentPart = z.union([textPart, imagePart, z.looseObject({ type: z.string() })])

const content = z.union([z.string(), z.array(contentPart)])

const toolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    arguments: z.string(),
  }),
})

const message = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: content.nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
})

const tool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
})

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({
    type: z.literal('function'),
    function: z.looseObject({ name: z.string() }),
  }),
])

export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  stream: z.boolean().optional(),
  stream_options: z
    .looseObject({ include_usage: z.boolean().optional() })
    .nullable()
    .optional(),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  n: z.number().int().positive().nullable().optional(),
  stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  response_format: z.looseObject({ type: z.string() }).optional(),
  user: z.string().optional(),
})

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>
export type ChatMessage = z.infer<typeof message>
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/schemas/chat.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/chat.ts tests/lib/schemas/chat.test.ts
git commit -m "feat: zod contract for the OpenAI chat request"
```

---

## Task 5: Error envelope and provider error classification

**Files:**
- Create: `src/lib/gateway/errors.ts`
- Test: `tests/lib/gateway/errors.test.ts`

**Interfaces:**
- Consumes: `openai` package (for `APIError`)
- Produces:
  - `class GatewayError extends Error` with `status`, `type`, `code`, `param`
  - `errorResponse(err: unknown): Response` — always the OpenAI envelope
  - `classifyProviderError(err: unknown): ClassifiedError`
  - `type ClassifiedError = { retryable: boolean; status: number; type: string; code: string | null; message: string }`
  - `class UnsupportedOperationError extends Error`

Classification rules, fixed here so Phase 2's failover loop inherits them:
retryable = no HTTP status (connection failure), `408`, `409`, `429`, or `>= 500`.
Everything else is fatal.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/gateway/errors.test.ts
import { expect, test } from 'vitest'
import OpenAI from 'openai'
import {
  GatewayError,
  UnsupportedOperationError,
  classifyProviderError,
  errorResponse,
} from '@/lib/gateway/errors'

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { error: { message, code: 'x' } }, message, undefined)
}

test('errorResponse renders the OpenAI envelope', async () => {
  const res = errorResponse(
    new GatewayError({ status: 404, type: 'invalid_request_error', code: 'model_not_found', message: 'no such model' }),
  )
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({
    error: { message: 'no such model', type: 'invalid_request_error', param: null, code: 'model_not_found' },
  })
})

test('errorResponse maps an unknown error to a 500 without leaking details', async () => {
  const res = errorResponse(new Error('connection string postgres://user:pw@host'))
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body.error.type).toBe('internal_error')
  expect(body.error.message).not.toContain('postgres://')
})

test.each([undefined, 408, 409, 429, 500, 502, 503, 504])(
  'status %s is retryable',
  (status) => {
    const err = status === undefined ? new OpenAI.APIConnectionError({}) : apiError(status)
    expect(classifyProviderError(err).retryable).toBe(true)
  },
)

test.each([400, 401, 403, 404, 413, 422])('status %s is fatal', (status) => {
  expect(classifyProviderError(apiError(status)).retryable).toBe(false)
})

test('classification preserves the upstream message and status', () => {
  const classified = classifyProviderError(apiError(400, 'context_length_exceeded'))
  expect(classified.status).toBe(400)
  expect(classified.message).toContain('context_length_exceeded')
})

test('an UnsupportedOperationError is fatal with status 501', () => {
  const classified = classifyProviderError(
    new UnsupportedOperationError('embeddings not supported by this provider'),
  )
  expect(classified.retryable).toBe(false)
  expect(classified.status).toBe(501)
})

test('an abort is classified as retryable', () => {
  const err = new DOMException('aborted', 'AbortError')
  expect(classifyProviderError(err).retryable).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/gateway/errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/errors`.

- [ ] **Step 3: Implement `src/lib/gateway/errors.ts`**

```ts
import OpenAI from 'openai'

export interface GatewayErrorInit {
  status: number
  type: string
  message: string
  code?: string | null
  param?: string | null
}

export class GatewayError extends Error {
  readonly status: number
  readonly type: string
  readonly code: string | null
  readonly param: string | null

  constructor(init: GatewayErrorInit) {
    super(init.message)
    this.name = 'GatewayError'
    this.status = init.status
    this.type = init.type
    this.code = init.code ?? null
    this.param = init.param ?? null
  }
}

export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedOperationError'
  }
}

export interface ClassifiedError {
  retryable: boolean
  status: number
  type: string
  code: string | null
  message: string
}

const RETRYABLE_STATUSES = new Set([408, 409, 429])

export function classifyProviderError(err: unknown): ClassifiedError {
  if (err instanceof UnsupportedOperationError) {
    return {
      retryable: false,
      status: 501,
      type: 'invalid_request_error',
      code: 'unsupported_operation',
      message: err.message,
    }
  }

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return {
      retryable,
      status: status ?? 502,
      type: err.type ?? (retryable ? 'api_error' : 'invalid_request_error'),
      code: err.code ?? null,
      message: err.message,
    }
  }

  const isAbort =
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')

  return {
    retryable: true,
    status: isAbort ? 504 : 502,
    type: 'api_error',
    code: isAbort ? 'upstream_timeout' : 'upstream_error',
    message: err instanceof Error ? err.message : 'Upstream request failed',
  }
}

export function errorBody(err: unknown) {
  if (err instanceof GatewayError) {
    return {
      error: { message: err.message, type: err.type, param: err.param, code: err.code },
    }
  }
  return {
    error: {
      message: 'The gateway encountered an internal error.',
      type: 'internal_error',
      param: null,
      code: null,
    },
  }
}

export function errorResponse(err: unknown, extraHeaders?: HeadersInit): Response {
  const status = err instanceof GatewayError ? err.status : 500
  if (!(err instanceof GatewayError)) console.error('[gateway] unhandled error', err)
  return Response.json(errorBody(err), { status, headers: extraHeaders })
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/gateway/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/errors.ts tests/lib/gateway/errors.test.ts
git commit -m "feat: OpenAI error envelope and provider error classification"
```

---

## Task 6: Adapter contract and registry

**Files:**
- Create: `src/lib/adapters/types.ts`, `src/lib/adapters/registry.ts`
- Test: `tests/lib/adapters/registry.test.ts`

**Interfaces:**
- Consumes: `ProviderRow` (Task 3), `ChatCompletionRequest` (Task 4), `decryptJson` (Task 2)
- Produces:
  - `interface AttemptContext { upstreamModel, credentials, baseUrl, config, signal, requestId }`
  - `interface ProviderAdapter { chat(req, ctx), chatStream(req, ctx) }`
  - `createAdapter(provider: ProviderRow): ProviderAdapter`
  - `resolveProviderRuntime(provider: ProviderRow): ProviderRuntime` — decrypts credentials and parses `config`

`chat` returns `OpenAI.Chat.Completions.ChatCompletion`; `chatStream` yields `OpenAI.Chat.Completions.ChatCompletionChunk`. Reusing the SDK's types keeps the wire contract honest instead of re-declaring it.

Phase 1 registers `openai` and `openai_compatible`. `gemini` and `bedrock` throw a clear `UnsupportedOperationError` until Phase 3.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/adapters/registry.test.ts
import { beforeEach, expect, test } from 'vitest'
import { createAdapter, resolveProviderRuntime } from '@/lib/adapters/registry'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { encryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
})

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'p',
    adapter: 'openai',
    baseUrl: null,
    credentials: encryptJson({ apiKey: 'sk-test' }),
    config: '{}',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProviderRow
}

test('resolveProviderRuntime decrypts credentials and parses config', () => {
  const runtime = resolveProviderRuntime(
    provider({ config: '{"disableStreamUsage":true}' }),
  )
  expect(runtime.credentials).toEqual({ apiKey: 'sk-test' })
  expect(runtime.config.disableStreamUsage).toBe(true)
})

test('creates an adapter for the openai type', () => {
  const adapter = createAdapter(provider())
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.chatStream).toBe('function')
})

test('creates an adapter for the openai_compatible type', () => {
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.x.ai/v1',
      credentials: encryptJson({ apiKey: 'xai-test' }),
    }),
  )
  expect(typeof adapter.chat).toBe('function')
})

test('openai_compatible without a base URL is rejected', () => {
  expect(() =>
    createAdapter(provider({ adapter: 'openai_compatible', baseUrl: null })),
  ).toThrow(/base URL/i)
})

test.each(['gemini', 'bedrock'] as const)('%s is not yet implemented', (adapter) => {
  expect(() => createAdapter(provider({ adapter }))).toThrow(UnsupportedOperationError)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/adapters/registry.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/registry`.

- [ ] **Step 3: Implement `src/lib/adapters/types.ts`**

```ts
import type OpenAI from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk

export interface ProviderConfig {
  /** Skip sending stream_options.include_usage — some clones reject it. */
  disableStreamUsage?: boolean
  /** Per-request upstream timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number
  [key: string]: unknown
}

export interface ProviderRuntime {
  id: string
  name: string
  adapter: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
  baseUrl: string | null
  credentials: Record<string, unknown>
  config: ProviderConfig
}

export interface AttemptContext {
  /** The provider's own model name, not the virtual one. */
  upstreamModel: string
  signal: AbortSignal
  requestId: string
}

export interface ProviderAdapter {
  chat(req: ChatCompletionRequest, ctx: AttemptContext): Promise<ChatCompletion>
  chatStream(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): AsyncIterable<ChatCompletionChunk>
}
```

- [ ] **Step 4: Implement `src/lib/adapters/registry.ts`**

```ts
import { decryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { createOpenAIAdapter } from './openai'
import type { ProviderAdapter, ProviderConfig, ProviderRuntime } from './types'

export function resolveProviderRuntime(provider: ProviderRow): ProviderRuntime {
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    credentials: decryptJson<Record<string, unknown>>(provider.credentials),
    config: JSON.parse(provider.config) as ProviderConfig,
  }
}

export function createAdapter(provider: ProviderRow): ProviderAdapter {
  const runtime = resolveProviderRuntime(provider)

  switch (runtime.adapter) {
    case 'openai':
      return createOpenAIAdapter(runtime)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return createOpenAIAdapter(runtime)
    case 'gemini':
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}
```

- [ ] **Step 5: Create a stub `src/lib/adapters/openai/index.ts` so the registry compiles**

Task 7 replaces the bodies. This stub exists only so Task 6's tests can run.

```ts
import type { ProviderAdapter, ProviderRuntime } from '../types'

export function createOpenAIAdapter(_runtime: ProviderRuntime): ProviderAdapter {
  return {
    async chat() {
      throw new Error('not implemented')
    },
    async *chatStream() {
      throw new Error('not implemented')
    },
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/lib/adapters/registry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/adapters tests/lib/adapters
git commit -m "feat: provider adapter contract and registry"
```

---
## Task 7: OpenAI adapter — non-streaming chat

**Files:**
- Modify: `src/lib/adapters/openai/index.ts` (replaces the Task 6 stub)
- Test: `tests/lib/adapters/openai/chat.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntime`, `AttemptContext`, `ProviderAdapter` (Task 6)
- Produces:
  - `createOpenAIAdapter(runtime: ProviderRuntime, createClient?: OpenAIClientFactory): ProviderAdapter`
  - `type OpenAIClientFactory = (opts: ClientOptions) => OpenAI`

The client factory is injected rather than mocked at the module level. Tests pass a fake and assert on the exact arguments the SDK received — no `vi.mock`, no import juggling.

The adapter must:
1. Replace `model` with `ctx.upstreamModel`.
2. Forward every other field verbatim, including unknown ones.
3. Pass `ctx.signal` through so a timeout or client disconnect aborts the upstream call.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/adapters/openai/chat.test.ts
import { expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'openai-prod',
  adapter: 'openai',
  baseUrl: null,
  credentials: { apiKey: 'sk-test', organization: 'org-1' },
  config: {},
}

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const completion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

function fakeClient() {
  const create = vi.fn().mockResolvedValue(completion)
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  return { create, factory }
}

test('builds the client from credentials and base URL', async () => {
  const { factory } = fakeClient()
  const adapter = createOpenAIAdapter(
    { ...runtime, adapter: 'openai_compatible', baseUrl: 'https://api.x.ai/v1' },
    factory as never,
  )
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.x.ai/v1' }),
  )
})

test('substitutes the upstream model name', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(create.mock.calls[0][0].model).toBe('gpt-4o-mini')
})

test('forwards unknown provider parameters untouched', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat(
    {
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
      search_parameters: { mode: 'auto' },
      temperature: 0.2,
    } as never,
    ctx,
  )

  const sent = create.mock.calls[0][0]
  expect(sent.search_parameters).toEqual({ mode: 'auto' })
  expect(sent.temperature).toBe(0.2)
})

test('never sends stream: true on the non-streaming path', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat(
    { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )
  expect(create.mock.calls[0][0].stream).toBe(false)
})

test('passes the abort signal to the SDK', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await adapter.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, ctx)
  expect(create.mock.calls[0][1]).toMatchObject({ signal: ctx.signal })
})

test('returns the upstream completion unchanged', async () => {
  const { factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const result = await adapter.chat(
    { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
    ctx,
  )
  expect(result).toEqual(completion)
})

test('throws when the credentials have no apiKey', () => {
  const { factory } = fakeClient()
  expect(() =>
    createOpenAIAdapter({ ...runtime, credentials: {} }, factory as never),
  ).toThrow(/apiKey/i)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/adapters/openai/chat.test.ts`
Expected: FAIL — the stub throws `not implemented`.

- [ ] **Step 3: Replace `src/lib/adapters/openai/index.ts`**

```ts
import OpenAI, { type ClientOptions } from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'

export type OpenAIClientFactory = (opts: ClientOptions) => OpenAI

const defaultFactory: OpenAIClientFactory = (opts) => new OpenAI(opts)

interface OpenAICredentials {
  apiKey?: string
  organization?: string
  project?: string
}

export function createOpenAIAdapter(
  runtime: ProviderRuntime,
  createClient: OpenAIClientFactory = defaultFactory,
): ProviderAdapter {
  const credentials = runtime.credentials as OpenAICredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  const client = createClient({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    ...(credentials.organization ? { organization: credentials.organization } : {}),
    ...(credentials.project ? { project: credentials.project } : {}),
    maxRetries: 0,
  })

  function upstreamParams(req: ChatCompletionRequest, ctx: AttemptContext) {
    const { model: _ignored, ...rest } = req
    return { ...rest, model: ctx.upstreamModel }
  }

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      const params = { ...upstreamParams(req, ctx), stream: false as const }
      return (await client.chat.completions.create(params as never, {
        signal: ctx.signal,
      })) as ChatCompletion
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      const base = upstreamParams(req, ctx)
      const streamOptions = runtime.config.disableStreamUsage
        ? {}
        : { stream_options: { include_usage: true, ...(base.stream_options ?? {}) } }

      const stream = (await client.chat.completions.create(
        { ...base, ...streamOptions, stream: true } as never,
        { signal: ctx.signal },
      )) as AsyncIterable<ChatCompletionChunk>

      for await (const chunk of stream) yield chunk
    },
  }
}
```

`maxRetries: 0` is deliberate: retrying is the gateway's job, and the SDK retrying underneath would make failover timing and attempt logging wrong.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/adapters/openai/chat.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adapters/openai tests/lib/adapters/openai
git commit -m "feat: OpenAI adapter non-streaming chat"
```

---

## Task 8: OpenAI adapter — streaming and tool calls

**Files:**
- Test: `tests/lib/adapters/openai/stream.test.ts`
- Create: `tests/fixtures/openai-tool-call-stream.json`

**Interfaces:**
- Consumes: `createOpenAIAdapter` (Task 7)
- Produces: no new exports — this task proves and hardens `chatStream`

The fixture is a recorded upstream chunk sequence for a tool call. Replaying it through the adapter and asserting the emitted sequence is the pattern every future provider adapter reuses.

- [ ] **Step 1: Write the fixture `tests/fixtures/openai-tool-call-stream.json`**

```json
[
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "" }, "finish_reason": null }]
  },
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "" } }] }, "finish_reason": null }]
  },
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"city\":" } }] }, "finish_reason": null }]
  },
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "\"Paris\"}" } }] }, "finish_reason": null }]
  },
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
  },
  {
    "id": "chatcmpl-up", "object": "chat.completion.chunk", "created": 1, "model": "gpt-4o-mini",
    "choices": [],
    "usage": { "prompt_tokens": 40, "completion_tokens": 12, "total_tokens": 52 }
  }
]
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/lib/adapters/openai/stream.test.ts
import { expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import type { ChatCompletionChunk, ProviderRuntime } from '@/lib/adapters/types'
import fixture from '../../../fixtures/openai-tool-call-stream.json'

const runtime: ProviderRuntime = {
  id: 'p1', name: 'openai-prod', adapter: 'openai', baseUrl: null,
  credentials: { apiKey: 'sk-test' }, config: {},
}

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const request = { model: 'fast', messages: [{ role: 'user' as const, content: 'weather?' }], stream: true }

function streamingClient(chunks: unknown[] = fixture) {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  return { create, factory }
}

async function collect(iterable: AsyncIterable<ChatCompletionChunk>) {
  const out: ChatCompletionChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('requests usage in the stream by default', async () => {
  const { create, factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  await collect(adapter.chatStream(request, ctx))

  const sent = create.mock.calls[0][0]
  expect(sent.stream).toBe(true)
  expect(sent.stream_options).toEqual({ include_usage: true })
})

test('omits stream_options when the provider config disables it', async () => {
  const { create, factory } = streamingClient()
  const adapter = createOpenAIAdapter(
    { ...runtime, config: { disableStreamUsage: true } },
    factory as never,
  )
  await collect(adapter.chatStream(request, ctx))
  expect(create.mock.calls[0][0].stream_options).toBeUndefined()
})

test('emits every upstream chunk in order', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))
  expect(chunks).toHaveLength(fixture.length)
})

test('tool call argument fragments reassemble into valid JSON', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const args = chunks
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('the tool call id and name arrive on the opening fragment only', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const fragments = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  expect(fragments[0].id).toBe('call_1')
  expect(fragments[0].function?.name).toBe('get_weather')
  expect(fragments.slice(1).every((f) => f.id === undefined)).toBe(true)
})

test('the final chunk carries usage and the finish reason precedes it', async () => {
  const { factory } = streamingClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls')
})

test('an error thrown before the first chunk propagates to the caller', async () => {
  const create = vi.fn().mockRejectedValue(new Error('upstream down'))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  const adapter = createOpenAIAdapter(runtime, factory as never)

  await expect(collect(adapter.chatStream(request, ctx))).rejects.toThrow('upstream down')
})

test('an error thrown mid-stream propagates after the earlier chunks', async () => {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      yield fixture[0]
      throw new Error('connection reset')
    },
  }))
  const factory = vi.fn().mockReturnValue({ chat: { completions: { create } } })
  const adapter = createOpenAIAdapter(runtime, factory as never)

  const seen: ChatCompletionChunk[] = []
  await expect(async () => {
    for await (const chunk of adapter.chatStream(request, ctx)) seen.push(chunk)
  }).rejects.toThrow('connection reset')
  expect(seen).toHaveLength(1)
})
```

- [ ] **Step 3: Enable JSON imports and run to verify it fails**

Add `"resolveJsonModule": true` to `compilerOptions` in `tsconfig.json` if it is not already present.

Run: `pnpm test tests/lib/adapters/openai/stream.test.ts`
Expected: FAIL — `stream_options` assertions fail or chunks are missing.

- [ ] **Step 4: Fix the implementation until the tests pass**

The Task 7 implementation of `chatStream` should already satisfy these. If the `stream_options` merge test fails, the spread order in `createOpenAIAdapter` is wrong — the caller's `stream_options` must override `include_usage`, and `disableStreamUsage` must suppress the key entirely rather than set it to `undefined`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/lib/adapters/openai`
Expected: PASS, 15 tests across both files.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: OpenAI adapter streaming and tool call translation"
```

---

## Task 9: Virtual API key generation and resolution

**Files:**
- Create: `src/lib/gateway/auth.ts`
- Test: `tests/lib/gateway/auth.test.ts`

**Interfaces:**
- Consumes: `db`, `apiKeys` (Task 3), `GatewayError` (Task 5)
- Produces:
  - `generateApiKey(): { key: string; keyHash: string; keyPrefix: string }`
  - `hashApiKey(key: string): string`
  - `extractBearerToken(request: Request): string | null`
  - `resolveApiKey(token: string | null): Promise<ApiKeyRow>` — throws `GatewayError` 401
  - `touchApiKey(id: string): Promise<void>` — fire-and-forget `last_used_at` update

Keys look like `sk-bab-<43 base64url chars>`. The prefix stored for display is the first 12 characters.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/gateway/auth.test.ts
import { beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  extractBearerToken, generateApiKey, hashApiKey, resolveApiKey, touchApiKey,
} from '@/lib/gateway/auth'
import { GatewayError } from '@/lib/gateway/errors'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

async function insertKey(overrides: Record<string, unknown> = {}) {
  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    ...overrides,
  }).returning()
  return { ...generated, row }
}

test('generated keys are prefixed, unique, and hashed deterministically', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  expect(a.key).toMatch(/^sk-bab-[A-Za-z0-9_-]{43}$/)
  expect(a.key).not.toBe(b.key)
  expect(a.keyPrefix).toBe(a.key.slice(0, 12))
  expect(a.keyHash).toBe(hashApiKey(a.key))
  expect(a.keyHash).not.toContain(a.key)
})

test('extractBearerToken reads the Authorization header', () => {
  const request = new Request('http://x/v1/chat/completions', {
    headers: { authorization: 'Bearer sk-bab-abc' },
  })
  expect(extractBearerToken(request)).toBe('sk-bab-abc')
})

test('extractBearerToken is case-insensitive on the scheme and returns null when absent', () => {
  expect(
    extractBearerToken(new Request('http://x', { headers: { authorization: 'bearer tok' } })),
  ).toBe('tok')
  expect(extractBearerToken(new Request('http://x'))).toBeNull()
  expect(
    extractBearerToken(new Request('http://x', { headers: { authorization: 'Basic tok' } })),
  ).toBeNull()
})

test('resolveApiKey returns the row for a valid key', async () => {
  const { key, row } = await insertKey()
  expect((await resolveApiKey(key)).id).toBe(row.id)
})

test('resolveApiKey rejects a missing token', async () => {
  await expect(resolveApiKey(null)).rejects.toThrow(GatewayError)
})

test('resolveApiKey rejects an unknown key with 401', async () => {
  await expect(resolveApiKey('sk-bab-nope')).rejects.toMatchObject({ status: 401 })
})

test('resolveApiKey rejects a disabled key', async () => {
  const { key } = await insertKey({ enabled: false })
  await expect(resolveApiKey(key)).rejects.toMatchObject({
    status: 401, code: 'key_disabled',
  })
})

test('resolveApiKey rejects an expired key', async () => {
  const { key } = await insertKey({ expiresAt: new Date(Date.now() - 1000) })
  await expect(resolveApiKey(key)).rejects.toMatchObject({
    status: 401, code: 'key_expired',
  })
})

test('resolveApiKey accepts a key whose expiry is in the future', async () => {
  const { key } = await insertKey({ expiresAt: new Date(Date.now() + 60_000) })
  await expect(resolveApiKey(key)).resolves.toBeDefined()
})

test('touchApiKey records last_used_at', async () => {
  const { row } = await insertKey()
  expect(row.lastUsedAt).toBeNull()
  await touchApiKey(row.id)
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, row.id))
  expect(updated.lastUsedAt).toBeInstanceOf(Date)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/gateway/auth.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/auth`.

- [ ] **Step 3: Implement `src/lib/gateway/auth.ts`**

```ts
import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, type ApiKeyRow } from '@/lib/db/schema'
import { GatewayError } from './errors'

const KEY_PREFIX = 'sk-bab-'
const PREFIX_DISPLAY_LENGTH = 12

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function generateApiKey() {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, PREFIX_DISPLAY_LENGTH) }
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

function unauthorized(message: string, code: string): GatewayError {
  return new GatewayError({
    status: 401,
    type: 'invalid_request_error',
    code,
    message,
  })
}

export async function resolveApiKey(token: string | null): Promise<ApiKeyRow> {
  if (!token) {
    throw unauthorized(
      'No API key provided. Send it as: Authorization: Bearer <key>.',
      'missing_api_key',
    )
  }

  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(token)))
    .limit(1)

  if (!key) throw unauthorized('Incorrect API key provided.', 'invalid_api_key')
  if (!key.enabled) throw unauthorized('This API key has been disabled.', 'key_disabled')
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('This API key has expired.', 'key_expired')
  }

  return key
}

export async function touchApiKey(id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id))
}
```

Lookup is by hash on a unique index, so no timing-safe comparison is needed — an attacker cannot learn anything from the query duration that they do not already know.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/gateway/auth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/auth.ts tests/lib/gateway/auth.test.ts
git commit -m "feat: virtual API key generation and resolution"
```

---
## Task 10: Virtual model resolution and response identity

**Files:**
- Create: `src/lib/gateway/resolve.ts`, `src/lib/gateway/identity.ts`
- Test: `tests/lib/gateway/resolve.test.ts`, `tests/lib/gateway/identity.test.ts`

**Interfaces:**
- Consumes: `db`, `virtualModels`, `routeTargets`, `providers` (Task 3), `GatewayError` (Task 5)
- Produces:
  - `interface Candidate { targetId: string; provider: ProviderRow; upstreamModel: string }`
  - `resolveVirtualModel(name: string): Promise<{ model: VirtualModelRow; candidates: Candidate[] }>`
  - `newCompletionId(): string`
  - `rewriteCompletion(res: ChatCompletion, opts: { id: string; model: string }): ChatCompletion`
  - `rewriteChunk(chunk: ChatCompletionChunk, opts: { id: string; model: string }): ChatCompletionChunk`

Phase 1 orders candidates by `priority` ascending then `created_at` ascending and the handler takes the first. Phase 2 replaces the ordering with the policy engine — the signature does not change.

- [ ] **Step 1: Write the failing resolution tests**

```ts
// tests/lib/gateway/resolve.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { resolveVirtualModel } from '@/lib/gateway/resolve'
import { encryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
})

async function seed() {
  const [fast] = await db.insert(providers).values({
    name: 'fast-provider', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  const [slow] = await db.insert(providers).values({
    name: 'slow-provider', adapter: 'openai', credentials: encryptJson({ apiKey: 'b' }),
  }).returning()
  const [model] = await db.insert(virtualModels).values({ name: 'house-model' }).returning()
  return { fast, slow, model }
}

test('returns candidates ordered by priority', async () => {
  const { fast, slow, model } = await seed()
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 10 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 1 },
  ])

  const { candidates } = await resolveVirtualModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1', 'slow-1'])
  expect(candidates[0].provider.name).toBe('fast-provider')
})

test('excludes disabled targets and targets on disabled providers', async () => {
  const { fast, slow, model } = await seed()
  await db.update(providers).set({ enabled: false }).where(eq(providers.id, slow.id))
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: slow.id, upstreamModel: 'slow-1', priority: 1 },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'disabled-1', priority: 2, enabled: false },
    { virtualModelId: model.id, providerId: fast.id, upstreamModel: 'fast-1', priority: 3 },
  ])

  const { candidates } = await resolveVirtualModel('house-model')
  expect(candidates.map((c) => c.upstreamModel)).toEqual(['fast-1'])
})

test('throws 404 for an unknown model name', async () => {
  await expect(resolveVirtualModel('nope')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 404 for a disabled virtual model', async () => {
  await db.insert(virtualModels).values({ name: 'off', enabled: false })
  await expect(resolveVirtualModel('off')).rejects.toMatchObject({
    status: 404, code: 'model_not_found',
  })
})

test('throws 503 when a model exists but has no usable targets', async () => {
  await seed()
  await expect(resolveVirtualModel('house-model')).rejects.toMatchObject({
    status: 503, code: 'no_targets_available',
  })
})
```

Add `import { eq } from 'drizzle-orm'` at the top of that file.

- [ ] **Step 2: Write the failing identity tests**

```ts
// tests/lib/gateway/identity.test.ts
import { expect, test } from 'vitest'
import { newCompletionId, rewriteChunk, rewriteCompletion } from '@/lib/gateway/identity'

const opts = { id: 'chatcmpl-gateway', model: 'house-model' }

test('generates a unique OpenAI-shaped completion id', () => {
  expect(newCompletionId()).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(newCompletionId()).not.toBe(newCompletionId())
})

test('rewrites the id and model on a completion, preserving everything else', () => {
  const upstream = {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 7, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    system_fingerprint: 'fp_1',
  }

  const result = rewriteCompletion(upstream as never, opts)
  expect(result.id).toBe('chatcmpl-gateway')
  expect(result.model).toBe('house-model')
  expect(result.created).toBe(7)
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(3)
  expect((result as Record<string, unknown>).system_fingerprint).toBe('fp_1')
})

test('rewrites the id and model on a chunk without touching the delta', () => {
  const chunk = {
    id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 7, model: 'gpt-4o-mini',
    choices: [{ index: 0, delta: { content: 'he' }, finish_reason: null }],
  }

  const result = rewriteChunk(chunk as never, opts)
  expect(result.id).toBe('chatcmpl-gateway')
  expect(result.model).toBe('house-model')
  expect(result.choices[0].delta.content).toBe('he')
})

test('rewriting does not mutate the upstream object', () => {
  const chunk = {
    id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 7, model: 'gpt-4o-mini',
    choices: [],
  }
  rewriteChunk(chunk as never, opts)
  expect(chunk.id).toBe('chatcmpl-upstream')
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm test tests/lib/gateway/resolve.test.ts tests/lib/gateway/identity.test.ts`
Expected: FAIL — modules do not resolve.

- [ ] **Step 4: Implement `src/lib/gateway/identity.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'

export interface IdentityOptions {
  id: string
  model: string
}

export function newCompletionId(): string {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`
}

export function rewriteCompletion(
  res: ChatCompletion,
  { id, model }: IdentityOptions,
): ChatCompletion {
  return { ...res, id, model }
}

export function rewriteChunk(
  chunk: ChatCompletionChunk,
  { id, model }: IdentityOptions,
): ChatCompletionChunk {
  return { ...chunk, id, model }
}
```

- [ ] **Step 5: Implement `src/lib/gateway/resolve.ts`**

```ts
import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  providers, routeTargets, virtualModels,
  type ProviderRow, type VirtualModelRow,
} from '@/lib/db/schema'
import { GatewayError } from './errors'

export interface Candidate {
  targetId: string
  provider: ProviderRow
  upstreamModel: string
}

export interface ResolvedModel {
  model: VirtualModelRow
  candidates: Candidate[]
}

export async function resolveVirtualModel(name: string): Promise<ResolvedModel> {
  const [model] = await db
    .select()
    .from(virtualModels)
    .where(and(eq(virtualModels.name, name), eq(virtualModels.enabled, true)))
    .limit(1)

  if (!model) {
    throw new GatewayError({
      status: 404,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
      message: `The model \`${name}\` does not exist.`,
    })
  }

  const rows = await db
    .select({ target: routeTargets, provider: providers })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .where(
      and(
        eq(routeTargets.virtualModelId, model.id),
        eq(routeTargets.enabled, true),
        eq(providers.enabled, true),
      ),
    )
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt))

  if (rows.length === 0) {
    throw new GatewayError({
      status: 503,
      type: 'api_error',
      code: 'no_targets_available',
      message: `The model \`${name}\` has no enabled route targets.`,
    })
  }

  return {
    model,
    candidates: rows.map(({ target, provider }) => ({
      targetId: target.id,
      provider,
      upstreamModel: target.upstreamModel,
    })),
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/lib/gateway`
Expected: PASS — 9 new tests plus the earlier auth and error suites.

- [ ] **Step 7: Commit**

```bash
git add src/lib/gateway tests/lib/gateway
git commit -m "feat: virtual model resolution and response identity rewriting"
```

---

## Task 11: Chat completions handler — non-streaming

**Files:**
- Create: `src/lib/gateway/chat-handler.ts`, `src/app/v1/chat/completions/route.ts`
- Test: `tests/gateway/chat.test.ts`, `tests/helpers/gateway.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 5, 6, 9, 10
- Produces:
  - `interface ChatHandlerDeps { createAdapter: (provider: ProviderRow) => ProviderAdapter }`
  - `handleChatCompletions(request: Request, deps?: ChatHandlerDeps): Promise<Response>`

The route file is a three-line delegation. All logic lives in `chat-handler.ts` so tests can inject a fake adapter factory without module mocking.

- [ ] **Step 1: Write `tests/helpers/gateway.ts`**

```ts
import { db } from '@/lib/db'
import { apiKeys, providers, routeTargets, virtualModels } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { generateApiKey } from '@/lib/gateway/auth'
import type { ProviderAdapter } from '@/lib/adapters/types'

export interface SeedOptions {
  virtualModel?: string
  upstreamModel?: string
}

export async function seedGateway(options: SeedOptions = {}) {
  const virtualModel = options.virtualModel ?? 'house-model'
  const upstreamModel = options.upstreamModel ?? 'gpt-4o-mini'

  const [provider] = await db.insert(providers).values({
    name: 'test-provider',
    adapter: 'openai',
    credentials: encryptJson({ apiKey: 'sk-upstream' }),
  }).returning()

  const [model] = await db.insert(virtualModels).values({ name: virtualModel }).returning()

  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel,
  }).returning()

  const generated = generateApiKey()
  const [key] = await db.insert(apiKeys).values({
    name: 'test key',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
  }).returning()

  return { provider, model, target, key, apiKey: generated.key, virtualModel, upstreamModel }
}

export function chatRequest(body: unknown, apiKey: string | null) {
  return new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

export function fakeAdapterDeps(adapter: Partial<ProviderAdapter>) {
  return {
    createAdapter: () => ({
      async chat() {
        throw new Error('chat not stubbed')
      },
      async *chatStream() {
        throw new Error('chatStream not stubbed')
      },
      ...adapter,
    }) as ProviderAdapter,
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/gateway/chat.test.ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const upstreamCompletion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
})

test('returns a completion with gateway identity', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.model).toBe('house-model')
  expect(json.id).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(json.choices[0].message.content).toBe('hello')
  expect(json.usage.total_tokens).toBe(7)
})

test('passes the upstream model name to the adapter', async () => {
  const { apiKey } = await seedGateway({ upstreamModel: 'gpt-5-nano' })
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(chat.mock.calls[0][1].upstreamModel).toBe('gpt-5-nano')
})

test('reports the provider and upstream model in response headers', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  expect(res.headers.get('x-request-id')).toBeTruthy()
})

test('rejects a request with no API key', async () => {
  await seedGateway()
  const res = await handleChatCompletions(chatRequest(body, null), fakeAdapterDeps({}))
  expect(res.status).toBe(401)
  expect((await res.json()).error.code).toBe('missing_api_key')
})

test('rejects malformed JSON with 400', async () => {
  const { apiKey } = await seedGateway()
  const request = new Request('http://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: '{ not json',
  })

  const res = await handleChatCompletions(request, fakeAdapterDeps({}))
  expect(res.status).toBe(400)
  expect((await res.json()).error.type).toBe('invalid_request_error')
})

test('rejects a schema violation with 400 and names the parameter', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest({ model: 'house-model', messages: [] }, apiKey),
    fakeAdapterDeps({}),
  )
  expect(res.status).toBe(400)
  expect((await res.json()).error.param).toBe('messages')
})

test('rejects an unknown virtual model with 404', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest({ ...body, model: 'nope' }, apiKey),
    fakeAdapterDeps({}),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('model_not_found')
})

test('surfaces an upstream error with its status and message', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockRejectedValue(
    new OpenAI.APIError(400, { error: { message: 'context_length_exceeded' } }, 'context_length_exceeded', undefined),
  )

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('context_length_exceeded')
})

test('propagates an upstream 500 as 500 with type api_error', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockRejectedValue(
    new OpenAI.APIError(500, { error: { message: 'server error' } }, 'server error', undefined),
  )

  const res = await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  expect(res.status).toBe(500)
  expect((await res.json()).error.type).toBe('api_error')
})

test('records last_used_at on the key', async () => {
  const { apiKey, key } = await seedGateway()
  const chat = vi.fn().mockResolvedValue(upstreamCompletion)

  await handleChatCompletions(chatRequest(body, apiKey), fakeAdapterDeps({ chat }))
  const [updated] = await db.select().from(apiKeys)
  expect(updated.lastUsedAt).toBeInstanceOf(Date)
  expect(updated.id).toBe(key.id)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test tests/gateway/chat.test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/chat-handler`.

- [ ] **Step 4: Implement `src/lib/gateway/chat-handler.ts`**

```ts
import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter } from '@/lib/adapters/registry'
import type { AttemptContext, ProviderAdapter } from '@/lib/adapters/types'
import type { ProviderRow } from '@/lib/db/schema'
import { chatCompletionRequestSchema } from '@/lib/schemas/chat'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { GatewayError, classifyProviderError, errorResponse } from './errors'
import { newCompletionId, rewriteCompletion } from './identity'
import { resolveVirtualModel, type Candidate } from './resolve'

const DEFAULT_TIMEOUT_MS = 120_000

export interface ChatHandlerDeps {
  createAdapter: (provider: ProviderRow) => ProviderAdapter
}

const defaultDeps: ChatHandlerDeps = { createAdapter: defaultCreateAdapter }

async function parseBody(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      message: 'Request body could not be parsed as JSON.',
    })
  }

  const result = chatCompletionRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = (result.error as z.ZodError).issues[0]
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param: issue.path.length > 0 ? String(issue.path[0]) : null,
      message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
    })
  }
  return result.data
}

export function attemptContext(
  candidate: Candidate,
  requestId: string,
  clientSignal: AbortSignal,
): AttemptContext {
  const config = JSON.parse(candidate.provider.config) as { timeoutMs?: number }
  return {
    upstreamModel: candidate.upstreamModel,
    requestId,
    signal: AbortSignal.any([
      clientSignal,
      AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ]),
  }
}

export function attemptHeaders(candidate: Candidate, requestId: string): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
  }
}

function upstreamFailure(err: unknown): GatewayError {
  const classified = classifyProviderError(err)
  return new GatewayError({
    status: classified.status,
    type: classified.type,
    code: classified.code,
    message: classified.message,
  })
}

export async function handleChatCompletions(
  request: Request,
  deps: ChatHandlerDeps = defaultDeps,
): Promise<Response> {
  const requestId = newCompletionId().replace('chatcmpl-', 'req_')

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    const body = await parseBody(request)
    const { candidates } = await resolveVirtualModel(body.model)

    // Phase 1 uses the highest-priority target only. Phase 2 walks the list.
    const candidate = candidates[0]
    const adapter = deps.createAdapter(candidate.provider)
    const ctx = attemptContext(candidate, requestId, request.signal)
    const headers = attemptHeaders(candidate, requestId)

    void touchApiKey(apiKey.id).catch((err) =>
      console.error('[gateway] failed to update last_used_at', err),
    )

    if (body.stream) {
      throw new GatewayError({
        status: 501,
        type: 'api_error',
        code: 'streaming_not_implemented',
        message: 'Streaming is not implemented yet.',
      })
    }

    let completion
    try {
      completion = await adapter.chat(body, ctx)
    } catch (err) {
      throw upstreamFailure(err)
    }

    return Response.json(
      rewriteCompletion(completion, { id: newCompletionId(), model: body.model }),
      { headers },
    )
  } catch (err) {
    return errorResponse(err, { 'x-request-id': requestId })
  }
}
```

The `streaming_not_implemented` guard is removed in Task 12. It exists so this task's deliverable is honest about what it does rather than silently ignoring `stream: true`.

- [ ] **Step 5: Implement `src/app/v1/chat/completions/route.ts`**

```ts
import { handleChatCompletions } from '@/lib/gateway/chat-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleChatCompletions(request)
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/gateway/chat.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: non-streaming chat completions endpoint"
```

---
## Task 12: Chat completions handler — streaming

**Files:**
- Create: `src/lib/gateway/sse.ts`, `tests/helpers/sse.ts`
- Modify: `src/lib/gateway/chat-handler.ts` (remove the not-implemented guard, add the streaming path)
- Test: `tests/gateway/chat-stream.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter.chatStream`, `rewriteChunk`, `classifyProviderError`
- Produces:
  - `startChatStream(source: AsyncIterable<ChatCompletionChunk>): Promise<AsyncIterable<ChatCompletionChunk>>` — pulls the first chunk before returning, so a pre-first-chunk failure throws instead of committing the response
  - `sseResponse(chunks: AsyncIterable<ChatCompletionChunk>, identity: IdentityOptions, headers: HeadersInit): Response`

**The commit boundary.** `startChatStream` awaits the first chunk *before* the handler builds a `Response`. If the upstream fails at connect time, the client receives a normal JSON error with a real status code. Once the first chunk exists the response is committed and a later failure can only terminate the stream with a final `error` event. Phase 2 hangs failover off exactly this boundary.

- [ ] **Step 1: Write `tests/helpers/sse.ts`**

```ts
export interface SseEvent {
  data: string
}

export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      data: block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    }))
}

export function parseSseChunks(body: string): unknown[] {
  return parseSse(body)
    .filter((event) => event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data))
}

export function sseTerminated(body: string): boolean {
  return parseSse(body).at(-1)?.data === '[DONE]'
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/gateway/chat-stream.test.ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { parseSse, parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-tool-call-stream.json'

const body = {
  model: 'house-model',
  messages: [{ role: 'user', content: 'weather?' }],
  stream: true,
}

function streamOf(chunks: unknown[]) {
  return async function* chatStream() {
    for (const chunk of chunks) yield chunk
  }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
})

test('responds with an SSE content type and no-transform caching', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.headers.get('cache-control')).toContain('no-transform')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
})

test('streams every chunk and terminates with [DONE]', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const text = await res.text()

  expect(parseSseChunks(text)).toHaveLength(fixture.length)
  expect(sseTerminated(text)).toBe(true)
})

test('every streamed chunk carries the virtual model and one stable gateway id', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{ id: string; model: string }>

  expect(new Set(chunks.map((c) => c.id)).size).toBe(1)
  expect(chunks[0].id).toMatch(/^chatcmpl-[a-f0-9]{32}$/)
  expect(chunks.every((c) => c.model === 'house-model')).toBe(true)
})

test('tool call fragments survive the stream intact', async () => {
  const { apiKey } = await seedGateway()
  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf(fixture) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{
    choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>
  }>

  const args = chunks
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('a failure before the first chunk returns a JSON error, not a stream', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    throw new OpenAI.APIError(429, { error: { message: 'rate limited' } }, 'rate limited', undefined)
    // eslint-disable-next-line no-unreachable
    yield undefined as never
  }

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )

  expect(res.status).toBe(429)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect((await res.json()).error.message).toContain('rate limited')
})

test('a mid-stream failure emits an error event then [DONE] on an already-committed 200', async () => {
  const { apiKey } = await seedGateway()
  const chatStream = async function* () {
    yield fixture[0]
    throw new Error('connection reset')
  }

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  expect(res.status).toBe(200)

  const text = await res.text()
  const events = parseSse(text)
  const errorEvent = JSON.parse(events.at(-2)!.data)

  expect(parseSseChunks(text)).toHaveLength(2)
  expect(errorEvent.error.code).toBe('stream_interrupted')
  expect(errorEvent.error.message).toContain('connection reset')
  expect(sseTerminated(text)).toBe(true)
})

test('a non-streaming request is unaffected by the streaming path', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn().mockResolvedValue({
    id: 'up', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  })

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: false }, apiKey),
    fakeAdapterDeps({ chat }),
  )
  expect(res.headers.get('content-type')).toContain('application/json')
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test tests/gateway/chat-stream.test.ts`
Expected: FAIL — the handler returns 501 `streaming_not_implemented`.

- [ ] **Step 4: Implement `src/lib/gateway/sse.ts`**

```ts
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import { classifyProviderError } from './errors'
import { rewriteChunk, type IdentityOptions } from './identity'

const encoder = new TextEncoder()

function event(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

const DONE = encoder.encode('data: [DONE]\n\n')

export interface StartedStream {
  chunks: AsyncIterable<ChatCompletionChunk>
}

/**
 * Pulls the first chunk eagerly. A failure here throws before the caller has
 * committed an HTTP response, which is what makes clean error status codes —
 * and, in Phase 2, failover — possible.
 */
export async function startChatStream(
  source: AsyncIterable<ChatCompletionChunk>,
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()

  return {
    async *[Symbol.asyncIterator]() {
      if (first.done) return
      yield first.value
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    },
  }
}

export function sseResponse(
  chunks: AsyncIterable<ChatCompletionChunk>,
  identity: IdentityOptions,
  headers: HeadersInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(event(rewriteChunk(chunk, identity)))
        }
      } catch (err) {
        const classified = classifyProviderError(err)
        controller.enqueue(
          event({
            error: {
              message: classified.message,
              type: classified.type,
              param: null,
              code: 'stream_interrupted',
            },
          }),
        )
      } finally {
        controller.enqueue(DONE)
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
```

`x-accel-buffering: no` stops nginx from buffering the stream, which would otherwise hold every token until the response ended.

- [ ] **Step 5: Replace the streaming guard in `src/lib/gateway/chat-handler.ts`**

Delete the `streaming_not_implemented` block and substitute:

```ts
    const identity = { id: newCompletionId(), model: body.model }

    if (body.stream) {
      let chunks
      try {
        chunks = await startChatStream(adapter.chatStream(body, ctx))
      } catch (err) {
        throw upstreamFailure(err)
      }
      return sseResponse(chunks, identity, headers)
    }

    let completion
    try {
      completion = await adapter.chat(body, ctx)
    } catch (err) {
      throw upstreamFailure(err)
    }

    return Response.json(rewriteCompletion(completion, identity), { headers })
```

Add the import:

```ts
import { sseResponse, startChatStream } from './sse'
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/gateway`
Expected: PASS, 17 tests across both gateway files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: streaming chat completions with a pre-commit failure boundary"
```

---

## Task 13: Admin session and login

**Files:**
- Create: `src/lib/admin/session.ts`, `src/app/login/page.tsx`, `src/app/login/actions.ts`, `src/app/(admin)/layout.tsx`
- Test: `tests/lib/admin/session.test.ts`

**Interfaces:**
- Consumes: `ADMIN_PASSWORD`, `SESSION_SECRET` env
- Produces:
  - `signSession(expiresAt: number): string`
  - `verifySession(token: string | undefined): boolean`
  - `SESSION_COOKIE = 'babellm_session'`
  - `login(password: string): Promise<boolean>` — sets the cookie on success
  - `logout(): Promise<void>`
  - `requireAdmin(): Promise<void>` — redirects to `/login` when unauthenticated

`requireAdmin()` is called by the admin layout **and** at the top of every Server Action. Layouts do not guard actions, so relying on the layout alone would leave every mutation open.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/admin/session.test.ts
import { beforeEach, expect, test } from 'vitest'
import { signSession, verifySession } from '@/lib/admin/session'

beforeEach(() => {
  process.env.SESSION_SECRET = 'f'.repeat(64)
})

test('a freshly signed session verifies', () => {
  expect(verifySession(signSession(Date.now() + 60_000))).toBe(true)
})

test('an expired session does not verify', () => {
  expect(verifySession(signSession(Date.now() - 1))).toBe(false)
})

test('a tampered expiry does not verify', () => {
  const token = signSession(Date.now() + 60_000)
  const [, signature] = token.split('.')
  expect(verifySession(`${Date.now() + 86_400_000}.${signature}`)).toBe(false)
})

test('a session signed with a different secret does not verify', () => {
  const token = signSession(Date.now() + 60_000)
  process.env.SESSION_SECRET = '0'.repeat(64)
  expect(verifySession(token)).toBe(false)
})

test('undefined and malformed tokens do not verify', () => {
  expect(verifySession(undefined)).toBe(false)
  expect(verifySession('garbage')).toBe(false)
  expect(verifySession('')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/admin/session.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/session`.

- [ ] **Step 3: Implement `src/lib/admin/session.ts`**

```ts
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export const SESSION_COOKIE = 'babellm_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters.')
  }
  return value
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function signSession(expiresAt: number): string {
  const payload = String(expiresAt)
  return `${payload}.${sign(payload)}`
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false

  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false

  const expiresAt = Number(payload)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies()
  return verifySession(store.get(SESSION_COOKIE)?.value)
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAuthenticated())) redirect('/login')
}

export async function login(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) throw new Error('ADMIN_PASSWORD is not set.')

  const a = Buffer.from(password)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  const store = await cookies()
  store.set(SESSION_COOKIE, signSession(Date.now() + SESSION_TTL_MS), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
  return true
}

export async function logout(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/admin/session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Install the UI kit**

```bash
pnpm dlx shadcn@latest init -d -y
pnpm dlx shadcn@latest add button input label select table badge dialog sonner switch textarea -y
```

- [ ] **Step 6: Write `src/app/login/actions.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import { login } from '@/lib/admin/session'

export async function loginAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const password = String(formData.get('password') ?? '')
  if (!(await login(password))) return { error: 'Incorrect password.' }
  redirect('/providers')
}
```

- [ ] **Step 7: Write `src/app/login/page.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loginAction } from './actions'

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, {})

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form action={action} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">BabeLLM Gateway</h1>
        <div className="space-y-2">
          <Label htmlFor="password">Admin password</Label>
          <Input id="password" name="password" type="password" autoFocus required />
        </div>
        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}
```

- [ ] **Step 8: Write `src/app/(admin)/layout.tsx`**

```tsx
import Link from 'next/link'
import { Toaster } from '@/components/ui/sonner'
import { requireAdmin } from '@/lib/admin/session'

const NAV = [
  { href: '/providers', label: 'Providers' },
  { href: '/models', label: 'Virtual models' },
  { href: '/keys', label: 'API keys' },
  { href: '/users', label: 'Users' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin()

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav className="mx-auto flex max-w-6xl gap-6 px-6 py-4 text-sm">
          <span className="font-semibold">BabeLLM</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <Toaster />
    </div>
  )
}
```

- [ ] **Step 9: Verify the login flow by hand**

Run `pnpm dev`, open `http://localhost:3000/providers`.
Expected: redirect to `/login`. A wrong password shows "Incorrect password."; `devpassword` lands on `/providers`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: admin session, login page, and admin shell"
```

---
## Task 14: Provider management

**Files:**
- Create: `src/lib/adapters/credentials.ts`, `src/lib/admin/providers.ts`
- Create: `src/app/(admin)/providers/page.tsx`, `src/app/(admin)/providers/actions.ts`, `src/app/(admin)/providers/provider-form.tsx`
- Test: `tests/lib/admin/providers.test.ts`

**Interfaces:**
- Consumes: `db`, `providers` (Task 3), `encryptJson` (Task 2), `createAdapter` (Task 6)
- Produces:
  - `credentialSchemas: Record<AdapterType, z.ZodType>`
  - `maskCredentials(adapter, credentials): Record<string, string>`
  - `listProviders(): Promise<ProviderListItem[]>`
  - `createProvider(input): Promise<ProviderRow>`
  - `updateProvider(id, input): Promise<ProviderRow>`
  - `deleteProvider(id): Promise<void>` — throws when route targets reference it
  - `testProvider(id, upstreamModel): Promise<{ ok: boolean; message: string }>`

`ProviderListItem` never carries a decrypted secret — only `maskedCredentials`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/admin/providers.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { providers, routeTargets, virtualModels } from '@/lib/db/schema'
import {
  createProvider, deleteProvider, listProviders, updateProvider,
} from '@/lib/admin/providers'
import { decryptJson } from '@/lib/crypto'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64)
  await resetDb()
})

test('creates a provider and encrypts its credentials', async () => {
  const row = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-real' },
  })
  expect(row.credentials).not.toContain('sk-real')
  expect(decryptJson<{ apiKey: string }>(row.credentials).apiKey).toBe('sk-real')
})

test('rejects credentials that do not match the adapter', async () => {
  await expect(
    createProvider({ name: 'bad', adapter: 'openai', credentials: { region: 'us-east-1' } }),
  ).rejects.toThrow(/apiKey/i)
})

test('rejects an openai_compatible provider with no base URL', async () => {
  await expect(
    createProvider({
      name: 'xai', adapter: 'openai_compatible', credentials: { apiKey: 'x' },
    }),
  ).rejects.toThrow(/base URL/i)
})

test('accepts bedrock credentials in both auth shapes', async () => {
  await createProvider({
    name: 'bedrock-keys', adapter: 'bedrock',
    credentials: { region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
  })
  await createProvider({
    name: 'bedrock-role', adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })
  expect(await listProviders()).toHaveLength(2)
})

test('listProviders masks secrets', async () => {
  await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-abcdefgh1234' },
  })
  const [item] = await listProviders()
  expect(item.maskedCredentials.apiKey).toBe('••••1234')
  expect(JSON.stringify(item)).not.toContain('sk-abcdefgh1234')
})

test('updating without credentials keeps the stored ones', async () => {
  const created = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-original' },
  })
  const updated = await updateProvider(created.id, { name: 'renamed' })
  expect(updated.name).toBe('renamed')
  expect(decryptJson<{ apiKey: string }>(updated.credentials).apiKey).toBe('sk-original')
})

test('updating with credentials replaces them', async () => {
  const created = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-original' },
  })
  const updated = await updateProvider(created.id, { credentials: { apiKey: 'sk-rotated' } })
  expect(decryptJson<{ apiKey: string }>(updated.credentials).apiKey).toBe('sk-rotated')
})

test('deleting a referenced provider is refused with a useful message', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const [model] = await db.insert(virtualModels).values({ name: 'm' }).returning()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mini',
  })

  await expect(deleteProvider(provider.id)).rejects.toThrow(/route target/i)
})

test('deleting an unreferenced provider succeeds', async () => {
  const provider = await createProvider({
    name: 'openai-prod', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  await deleteProvider(provider.id)
  expect(await db.select().from(providers)).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/providers`.

- [ ] **Step 3: Implement `src/lib/adapters/credentials.ts`**

```ts
import { z } from 'zod'

export const adapterTypes = ['openai', 'openai_compatible', 'gemini', 'bedrock'] as const
export type AdapterType = (typeof adapterTypes)[number]

const openaiCredentials = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
  organization: z.string().optional(),
  project: z.string().optional(),
})

const geminiCredentials = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
})

const bedrockCredentials = z.union([
  z.object({
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  }),
  z.object({
    region: z.string().min(1),
    useInstanceRole: z.literal(true),
  }),
])

export const credentialSchemas: Record<AdapterType, z.ZodType> = {
  openai: openaiCredentials,
  openai_compatible: openaiCredentials,
  gemini: geminiCredentials,
  bedrock: bedrockCredentials,
}

/** Fields whose values must never be echoed back to the browser. */
const SECRET_FIELDS = new Set(['apiKey', 'secretAccessKey', 'sessionToken'])

export function maskCredentials(
  credentials: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials).map(([key, value]) => {
      const text = String(value)
      if (!SECRET_FIELDS.has(key)) return [key, text]
      return [key, `••••${text.slice(-4)}`]
    }),
  )
}
```

- [ ] **Step 4: Implement `src/lib/admin/providers.ts`**

```ts
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
    throw new Error(result.error.issues.map((i) => i.message).join('; '))
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
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write `src/app/(admin)/providers/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  createProvider, deleteProvider, testProvider, updateProvider,
} from '@/lib/admin/providers'
import type { AdapterType } from '@/lib/adapters/credentials'

export interface ActionState {
  error?: string
  success?: string
}

function credentialsFrom(formData: FormData, adapter: AdapterType) {
  const entries: Record<string, unknown> = {}
  const fields =
    adapter === 'bedrock'
      ? ['region', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'useInstanceRole']
      : ['apiKey', 'organization', 'project']

  for (const field of fields) {
    const value = formData.get(field)
    if (field === 'useInstanceRole') {
      if (value === 'on') entries.useInstanceRole = true
      continue
    }
    if (typeof value === 'string' && value.length > 0) entries[field] = value
  }
  return entries
}

export async function createProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const adapter = String(formData.get('adapter')) as AdapterType

  try {
    await createProvider({
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      credentials: credentialsFrom(formData, adapter),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the provider.' }
  }

  revalidatePath('/providers')
  return { success: 'Provider created.' }
}

export async function toggleProviderAction(id: string, enabled: boolean): Promise<void> {
  await requireAdmin()
  await updateProvider(id, { enabled })
  revalidatePath('/providers')
}

export async function deleteProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await deleteProvider(String(formData.get('id')))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not delete the provider.' }
  }
  revalidatePath('/providers')
  return { success: 'Provider deleted.' }
}

export async function testProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const result = await testProvider(
    String(formData.get('id')),
    String(formData.get('upstreamModel') ?? ''),
  )
  return result.ok ? { success: result.message } : { error: result.message }
}
```

Every action calls `requireAdmin()` first. The admin layout does not protect Server Actions.

- [ ] **Step 7: Write `src/app/(admin)/providers/provider-form.tsx`**

```tsx
'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createProviderAction, type ActionState } from './actions'
import type { AdapterType } from '@/lib/adapters/credentials'

const ADAPTERS: AdapterType[] = ['openai', 'openai_compatible', 'gemini', 'bedrock']

export function ProviderForm() {
  const [adapter, setAdapter] = useState<AdapterType>('openai')
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createProviderAction,
    undefined,
  )

  return (
    <form action={action} className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Add a provider</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="openai-prod" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="adapter">Adapter</Label>
          <select
            id="adapter"
            name="adapter"
            value={adapter}
            onChange={(event) => setAdapter(event.target.value as AdapterType)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            {ADAPTERS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>

      {adapter === 'bedrock' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="region">Region</Label>
            <Input id="region" name="region" required placeholder="us-east-1" />
          </div>
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="useInstanceRole" /> Use the instance IAM role
          </label>
          <div className="space-y-2">
            <Label htmlFor="accessKeyId">Access key id</Label>
            <Input id="accessKeyId" name="accessKeyId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secretAccessKey">Secret access key</Label>
            <Input id="secretAccessKey" name="secretAccessKey" type="password" />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="apiKey">API key</Label>
            <Input id="apiKey" name="apiKey" type="password" required />
          </div>
          {adapter === 'openai_compatible' ? (
            <div className="space-y-2">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input id="baseUrl" name="baseUrl" required placeholder="https://api.x.ai/v1" />
            </div>
          ) : null}
        </div>
      )}

      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state?.success ? <p className="text-sm text-muted-foreground">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Add provider'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 8: Write `src/app/(admin)/providers/page.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { deleteProviderAction } from './actions'
import { ProviderForm } from './provider-form'

export const dynamic = 'force-dynamic'

export default async function ProvidersPage() {
  await requireAdmin()
  const providers = await listProviders()

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Providers</h1>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Name</th>
            <th>Adapter</th>
            <th>Credentials</th>
            <th>Targets</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id} className="border-t">
              <td className="py-2 font-medium">{provider.name}</td>
              <td>{provider.adapter}</td>
              <td className="font-mono text-xs">
                {Object.entries(provider.maskedCredentials)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' ')}
              </td>
              <td>{provider.targetCount}</td>
              <td>
                <Badge variant={provider.enabled ? 'default' : 'secondary'}>
                  {provider.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </td>
              <td className="text-right">
                <form action={deleteProviderAction}>
                  <input type="hidden" name="id" value={provider.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {providers.length === 0 ? (
            <tr><td colSpan={6} className="py-6 text-muted-foreground">No providers yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <ProviderForm />
    </div>
  )
}
```

- [ ] **Step 9: Verify by hand**

Run `pnpm dev`, sign in, add an OpenAI provider with a real key.
Expected: the row appears with `apiKey=••••` and the last 4 characters only.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: provider management with per-adapter credential validation"
```

---

## Task 15: Virtual model and route target management

**Files:**
- Create: `src/lib/admin/models.ts`
- Create: `src/app/(admin)/models/page.tsx`, `src/app/(admin)/models/actions.ts`, `src/app/(admin)/models/model-form.tsx`
- Test: `tests/lib/admin/models.test.ts`

**Interfaces:**
- Consumes: `db`, `virtualModels`, `routeTargets`, `providers` (Task 3)
- Produces:
  - `listVirtualModels(): Promise<VirtualModelListItem[]>` where the item carries `targets: Array<{ id, providerId, providerName, upstreamModel, priority, weight, enabled }>`
  - `createVirtualModel(input): Promise<VirtualModelRow>`
  - `updateVirtualModel(id, input): Promise<VirtualModelRow>`
  - `deleteVirtualModel(id): Promise<void>`
  - `addRouteTarget(input): Promise<RouteTargetRow>`
  - `removeRouteTarget(id): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/admin/models.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { routeTargets, virtualModels } from '@/lib/db/schema'
import { createProvider } from '@/lib/admin/providers'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel,
  listVirtualModels, removeRouteTarget, updateVirtualModel,
} from '@/lib/admin/models'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '2'.repeat(64)
  await resetDb()
})

async function provider(name = 'p') {
  return createProvider({ name, adapter: 'openai', credentials: { apiKey: 'sk-x' } })
}

test('creates a virtual model with failover as the default policy', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  expect(model.policy).toBe('failover')
  expect(model.maxAttempts).toBe(3)
  expect(model.enabled).toBe(true)
})

test('rejects a duplicate virtual model name', async () => {
  await createVirtualModel({ name: 'house-model' })
  await expect(createVirtualModel({ name: 'house-model' })).rejects.toThrow()
})

test('rejects a virtual model name that is empty or whitespace', async () => {
  await expect(createVirtualModel({ name: '   ' })).rejects.toThrow(/name/i)
})

test('adds targets and lists them ordered by priority with provider names', async () => {
  const [a, b] = [await provider('alpha'), await provider('beta')]
  const model = await createVirtualModel({ name: 'house-model' })

  await addRouteTarget({
    virtualModelId: model.id, providerId: b.id, upstreamModel: 'b-1', priority: 5, weight: 30,
  })
  await addRouteTarget({
    virtualModelId: model.id, providerId: a.id, upstreamModel: 'a-1', priority: 1, weight: 70,
  })

  const [listed] = await listVirtualModels()
  expect(listed.targets.map((t) => t.upstreamModel)).toEqual(['a-1', 'b-1'])
  expect(listed.targets[0].providerName).toBe('alpha')
  expect(listed.targets[0].weight).toBe(70)
})

test('rejects a target with a non-positive weight', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({
      virtualModelId: model.id, providerId: p.id, upstreamModel: 'x', weight: 0,
    }),
  ).rejects.toThrow(/weight/i)
})

test('rejects a target with an empty upstream model', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: '' }),
  ).rejects.toThrow(/upstream model/i)
})

test('updates the routing policy', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  const updated = await updateVirtualModel(model.id, { policy: 'weighted' })
  expect(updated.policy).toBe('weighted')
})

test('removing a target leaves the model intact', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'x',
  })

  await removeRouteTarget(target.id)
  expect(await db.select().from(routeTargets)).toHaveLength(0)
  expect(await db.select().from(virtualModels)).toHaveLength(1)
})

test('deleting a virtual model removes its targets', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: 'x' })

  await deleteVirtualModel(model.id)
  expect(await db.select().from(routeTargets)).toHaveLength(0)
  expect(await db.select().from(virtualModels)).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/admin/models.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/models`.

- [ ] **Step 3: Implement `src/lib/admin/models.ts`**

```ts
import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  providers, routeTargets, virtualModels,
  type RouteTargetRow, type VirtualModelRow,
} from '@/lib/db/schema'

export type RoutingPolicy = 'failover' | 'weighted' | 'round_robin'

export interface VirtualModelInput {
  name: string
  description?: string | null
  policy?: RoutingPolicy
  maxAttempts?: number
  enabled?: boolean
}

export interface RouteTargetInput {
  virtualModelId: string
  providerId: string
  upstreamModel: string
  priority?: number
  weight?: number
  enabled?: boolean
}

export interface VirtualModelListItem {
  id: string
  name: string
  description: string | null
  policy: RoutingPolicy
  maxAttempts: number
  enabled: boolean
  targets: Array<{
    id: string
    providerId: string
    providerName: string
    upstreamModel: string
    priority: number
    weight: number
    enabled: boolean
  }>
}

export async function listVirtualModels(): Promise<VirtualModelListItem[]> {
  const models = await db.select().from(virtualModels).orderBy(asc(virtualModels.name))
  const rows = await db
    .select({ target: routeTargets, providerName: providers.name })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt))

  return models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    policy: model.policy,
    maxAttempts: model.maxAttempts,
    enabled: model.enabled,
    targets: rows
      .filter(({ target }) => target.virtualModelId === model.id)
      .map(({ target, providerName }) => ({
        id: target.id,
        providerId: target.providerId,
        providerName,
        upstreamModel: target.upstreamModel,
        priority: target.priority,
        weight: target.weight,
        enabled: target.enabled,
      })),
  }))
}

export async function createVirtualModel(input: VirtualModelInput): Promise<VirtualModelRow> {
  const name = input.name.trim()
  if (!name) throw new Error('A virtual model name is required.')

  const [row] = await db.insert(virtualModels).values({
    name,
    description: input.description ?? null,
    policy: input.policy ?? 'failover',
    maxAttempts: input.maxAttempts ?? 3,
    enabled: input.enabled ?? true,
  }).returning()
  return row
}

export async function updateVirtualModel(
  id: string,
  input: Partial<VirtualModelInput>,
): Promise<VirtualModelRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('A virtual model name is required.')
    patch.name = name
  }
  if (input.description !== undefined) patch.description = input.description
  if (input.policy !== undefined) patch.policy = input.policy
  if (input.maxAttempts !== undefined) patch.maxAttempts = input.maxAttempts
  if (input.enabled !== undefined) patch.enabled = input.enabled

  const [row] = await db.update(virtualModels).set(patch)
    .where(eq(virtualModels.id, id)).returning()
  if (!row) throw new Error('Virtual model not found.')
  return row
}

export async function deleteVirtualModel(id: string): Promise<void> {
  await db.delete(virtualModels).where(eq(virtualModels.id, id))
}

export async function addRouteTarget(input: RouteTargetInput): Promise<RouteTargetRow> {
  const upstreamModel = input.upstreamModel.trim()
  if (!upstreamModel) throw new Error('An upstream model name is required.')

  const weight = input.weight ?? 100
  if (!Number.isInteger(weight) || weight < 1) {
    throw new Error('Target weight must be a positive integer.')
  }

  const [row] = await db.insert(routeTargets).values({
    virtualModelId: input.virtualModelId,
    providerId: input.providerId,
    upstreamModel,
    priority: input.priority ?? 0,
    weight,
    enabled: input.enabled ?? true,
  }).returning()
  return row
}

export async function removeRouteTarget(id: string): Promise<void> {
  await db.delete(routeTargets).where(eq(routeTargets.id, id))
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/admin/models.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write `src/app/(admin)/models/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel,
  removeRouteTarget, updateVirtualModel, type RoutingPolicy,
} from '@/lib/admin/models'

export interface ActionState {
  error?: string
  success?: string
}

export async function createModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await createVirtualModel({
      name: String(formData.get('name') ?? ''),
      description: (formData.get('description') as string) || null,
      policy: String(formData.get('policy') ?? 'failover') as RoutingPolicy,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the model.' }
  }
  revalidatePath('/models')
  return { success: 'Virtual model created.' }
}

export async function addTargetAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await addRouteTarget({
      virtualModelId: String(formData.get('virtualModelId')),
      providerId: String(formData.get('providerId')),
      upstreamModel: String(formData.get('upstreamModel') ?? ''),
      priority: Number(formData.get('priority') ?? 0),
      weight: Number(formData.get('weight') ?? 100),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not add the target.' }
  }
  revalidatePath('/models')
  return { success: 'Target added.' }
}

export async function setPolicyAction(id: string, policy: RoutingPolicy): Promise<void> {
  await requireAdmin()
  await updateVirtualModel(id, { policy })
  revalidatePath('/models')
}

export async function removeTargetAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await removeRouteTarget(String(formData.get('id')))
  revalidatePath('/models')
}

export async function deleteModelAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteVirtualModel(String(formData.get('id')))
  revalidatePath('/models')
}
```

- [ ] **Step 6: Write `src/app/(admin)/models/model-form.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addTargetAction, createModelAction, type ActionState } from './actions'

const POLICIES = ['failover', 'weighted', 'round_robin'] as const

export function CreateModelForm() {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createModelAction, undefined,
  )

  return (
    <form action={action} className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Add a virtual model</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="house-model" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="policy">Policy</Label>
          <select id="policy" name="policy" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
            {POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
          </select>
        </div>
      </div>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Add model'}</Button>
    </form>
  )
}

export function AddTargetForm({
  virtualModelId,
  providers,
}: {
  virtualModelId: string
  providers: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    addTargetAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 pt-2">
      <input type="hidden" name="virtualModelId" value={virtualModelId} />
      <div className="space-y-1">
        <Label htmlFor={`provider-${virtualModelId}`} className="text-xs">Provider</Label>
        <select
          id={`provider-${virtualModelId}`}
          name="providerId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`upstream-${virtualModelId}`} className="text-xs">Upstream model</Label>
        <Input id={`upstream-${virtualModelId}`} name="upstreamModel" required placeholder="gpt-4o-mini" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`priority-${virtualModelId}`} className="text-xs">Priority</Label>
        <Input id={`priority-${virtualModelId}`} name="priority" type="number" defaultValue={0} className="w-24" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`weight-${virtualModelId}`} className="text-xs">Weight</Label>
        <Input id={`weight-${virtualModelId}`} name="weight" type="number" defaultValue={100} className="w-24" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>Add target</Button>
      {state?.error ? <p role="alert" className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  )
}
```

- [ ] **Step 7: Write `src/app/(admin)/models/page.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listProviders } from '@/lib/admin/providers'
import { listVirtualModels } from '@/lib/admin/models'
import { requireAdmin } from '@/lib/admin/session'
import { deleteModelAction, removeTargetAction } from './actions'
import { AddTargetForm, CreateModelForm } from './model-form'

export const dynamic = 'force-dynamic'

export default async function ModelsPage() {
  await requireAdmin()
  const [models, providers] = await Promise.all([listVirtualModels(), listProviders()])

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Virtual models</h1>

      {models.map((model) => (
        <section key={model.id} className="space-y-2 rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-medium">{model.name}</h2>
            <Badge variant="secondary">{model.policy}</Badge>
            {!model.enabled ? <Badge variant="outline">disabled</Badge> : null}
            <form action={deleteModelAction} className="ml-auto">
              <input type="hidden" name="id" value={model.id} />
              <Button type="submit" variant="ghost" size="sm">Delete</Button>
            </form>
          </div>

          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-1">Provider</th><th>Upstream model</th><th>Priority</th><th>Weight</th><th /></tr>
            </thead>
            <tbody>
              {model.targets.map((target) => (
                <tr key={target.id} className="border-t">
                  <td className="py-1">{target.providerName}</td>
                  <td className="font-mono text-xs">{target.upstreamModel}</td>
                  <td>{target.priority}</td>
                  <td>{target.weight}</td>
                  <td className="text-right">
                    <form action={removeTargetAction}>
                      <input type="hidden" name="id" value={target.id} />
                      <Button type="submit" variant="ghost" size="sm">Remove</Button>
                    </form>
                  </td>
                </tr>
              ))}
              {model.targets.length === 0 ? (
                <tr><td colSpan={5} className="py-3 text-muted-foreground">No targets — requests to this model will fail with 503.</td></tr>
              ) : null}
            </tbody>
          </table>

          {providers.length > 0 ? <AddTargetForm virtualModelId={model.id} providers={providers} /> : null}
        </section>
      ))}

      <CreateModelForm />
    </div>
  )
}
```

- [ ] **Step 8: Verify by hand**

Run `pnpm dev`, create a virtual model, add a target pointing at the provider from Task 14.
Expected: the target lists with its provider name, priority, and weight.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: virtual model and route target management"
```

---
## Task 16: User and API key management

**Files:**
- Create: `src/lib/admin/keys.ts`
- Create: `src/app/(admin)/keys/page.tsx`, `src/app/(admin)/keys/actions.ts`, `src/app/(admin)/keys/key-form.tsx`
- Create: `src/app/(admin)/users/page.tsx`, `src/app/(admin)/users/actions.ts`
- Test: `tests/lib/admin/keys.test.ts`

**Interfaces:**
- Consumes: `db`, `apiKeys`, `users` (Task 3), `generateApiKey` (Task 9)
- Produces:
  - `listUsers(): Promise<UserRow[]>`, `createUser(input): Promise<UserRow>`, `deleteUser(id): Promise<void>`
  - `listApiKeys(): Promise<ApiKeyListItem[]>`
  - `createApiKey(input): Promise<{ item: ApiKeyListItem; plaintextKey: string }>` — the only time the plaintext exists
  - `setApiKeyEnabled(id, enabled): Promise<void>`
  - `deleteApiKey(id): Promise<void>`

The plaintext key is returned once by `createApiKey` and never stored. `ApiKeyListItem` exposes `keyPrefix` only.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/admin/keys.test.ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import {
  createApiKey, createUser, deleteApiKey, deleteUser,
  listApiKeys, listUsers, setApiKeyEnabled,
} from '@/lib/admin/keys'
import { hashApiKey } from '@/lib/gateway/auth'
import { resetDb } from '../../helpers/db'

beforeEach(resetDb)

test('creates a user', async () => {
  await createUser({ name: 'Ada Lovelace', email: 'ada@example.com' })
  const users = await listUsers()
  expect(users).toHaveLength(1)
  expect(users[0].name).toBe('Ada Lovelace')
})

test('rejects a blank user name', async () => {
  await expect(createUser({ name: '  ' })).rejects.toThrow(/name/i)
})

test('creates a key, returns the plaintext once, and stores only its hash', async () => {
  const { item, plaintextKey } = await createApiKey({ name: 'app key' })

  expect(plaintextKey).toMatch(/^sk-bab-[A-Za-z0-9_-]{43}$/)
  expect(item.keyPrefix).toBe(plaintextKey.slice(0, 12))
  expect(JSON.stringify(item)).not.toContain(plaintextKey)

  const [stored] = await db.select().from(apiKeys)
  expect(stored.keyHash).toBe(hashApiKey(plaintextKey))
})

test('a listed key never exposes the hash or the plaintext', async () => {
  const { plaintextKey } = await createApiKey({ name: 'app key' })
  const serialized = JSON.stringify(await listApiKeys())
  expect(serialized).not.toContain(plaintextKey)
  expect(serialized).not.toContain(hashApiKey(plaintextKey))
})

test('stores limits, budgets, and expiry', async () => {
  const expiresAt = new Date(Date.now() + 86_400_000)
  await createApiKey({
    name: 'limited',
    rpmLimit: 60,
    tpmLimit: 100_000,
    budgetMonthlyUsd: '25.000000',
    expiresAt,
  })

  const [item] = await listApiKeys()
  expect(item.rpmLimit).toBe(60)
  expect(item.tpmLimit).toBe(100_000)
  expect(item.budgetMonthlyUsd).toBe('25.000000')
  expect(item.expiresAt?.getTime()).toBe(expiresAt.getTime())
})

test('rejects a non-positive rate limit', async () => {
  await expect(createApiKey({ name: 'bad', rpmLimit: 0 })).rejects.toThrow(/rpm/i)
})

test('attributes a key to a user and shows the user name in the listing', async () => {
  const user = await createUser({ name: 'Ada' })
  await createApiKey({ name: 'ada key', userId: user.id })
  const [item] = await listApiKeys()
  expect(item.userName).toBe('Ada')
})

test('revoking a key disables it without deleting it', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  await setApiKeyEnabled(item.id, false)
  const [updated] = await listApiKeys()
  expect(updated.enabled).toBe(false)
})

test('deleting a key removes it', async () => {
  const { item } = await createApiKey({ name: 'app key' })
  await deleteApiKey(item.id)
  expect(await listApiKeys()).toHaveLength(0)
})

test('deleting a user detaches its keys rather than deleting them', async () => {
  const user = await createUser({ name: 'Ada' })
  await createApiKey({ name: 'ada key', userId: user.id })
  await deleteUser(user.id)

  const [item] = await listApiKeys()
  expect(item.userId).toBeNull()
  expect(item.userName).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/lib/admin/keys.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/keys`.

- [ ] **Step 3: Implement `src/lib/admin/keys.ts`**

```ts
import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, users, type UserRow } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'

export interface UserInput {
  name: string
  email?: string | null
  notes?: string | null
}

export interface ApiKeyInput {
  name: string
  userId?: string | null
  rpmLimit?: number | null
  tpmLimit?: number | null
  budgetTotalUsd?: string | null
  budgetMonthlyUsd?: string | null
  expiresAt?: Date | null
  logPayloads?: boolean
}

export interface ApiKeyListItem {
  id: string
  name: string
  keyPrefix: string
  userId: string | null
  userName: string | null
  enabled: boolean
  expiresAt: Date | null
  lastUsedAt: Date | null
  rpmLimit: number | null
  tpmLimit: number | null
  budgetTotalUsd: string | null
  budgetMonthlyUsd: string | null
  logPayloads: boolean
  createdAt: Date
}

export async function listUsers(): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.name))
}

export async function createUser(input: UserInput): Promise<UserRow> {
  const name = input.name.trim()
  if (!name) throw new Error('A user name is required.')
  const [row] = await db.insert(users).values({
    name, email: input.email ?? null, notes: input.notes ?? null,
  }).returning()
  return row
}

export async function deleteUser(id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id))
}

function validateLimit(value: number | null | undefined, label: string) {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const rows = await db
    .select({ key: apiKeys, userName: users.name })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .orderBy(asc(apiKeys.createdAt))

  return rows.map(({ key, userName }) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    userId: key.userId,
    userName: userName ?? null,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    budgetTotalUsd: key.budgetTotalUsd,
    budgetMonthlyUsd: key.budgetMonthlyUsd,
    logPayloads: key.logPayloads,
    createdAt: key.createdAt,
  }))
}

export async function createApiKey(
  input: ApiKeyInput,
): Promise<{ item: ApiKeyListItem; plaintextKey: string }> {
  const name = input.name.trim()
  if (!name) throw new Error('A key name is required.')

  const rpmLimit = validateLimit(input.rpmLimit, 'rpm limit')
  const tpmLimit = validateLimit(input.tpmLimit, 'tpm limit')

  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name,
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    userId: input.userId ?? null,
    rpmLimit,
    tpmLimit,
    budgetTotalUsd: input.budgetTotalUsd ?? null,
    budgetMonthlyUsd: input.budgetMonthlyUsd ?? null,
    expiresAt: input.expiresAt ?? null,
    logPayloads: input.logPayloads ?? false,
  }).returning()

  const userName = row.userId
    ? ((await db.select().from(users).where(eq(users.id, row.userId)))[0]?.name ?? null)
    : null

  return {
    plaintextKey: generated.key,
    item: {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      userId: row.userId,
      userName,
      enabled: row.enabled,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit,
      budgetTotalUsd: row.budgetTotalUsd,
      budgetMonthlyUsd: row.budgetMonthlyUsd,
      logPayloads: row.logPayloads,
      createdAt: row.createdAt,
    },
  }
}

export async function setApiKeyEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(apiKeys).set({ enabled }).where(eq(apiKeys.id, id))
}

export async function deleteApiKey(id: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, id))
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/admin/keys.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write `src/app/(admin)/users/actions.ts` and `page.tsx`**

```ts
// src/app/(admin)/users/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import { createUser, deleteUser } from '@/lib/admin/keys'

export async function createUserAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  await requireAdmin()
  try {
    await createUser({
      name: String(formData.get('name') ?? ''),
      email: (formData.get('email') as string) || null,
      notes: (formData.get('notes') as string) || null,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the user.' }
  }
  revalidatePath('/users')
  return {}
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteUser(String(formData.get('id')))
  revalidatePath('/users')
  revalidatePath('/keys')
}
```

```tsx
// src/app/(admin)/users/page.tsx
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { createUserAction, deleteUserAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  await requireAdmin()
  const users = await listUsers()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Labels for attributing API keys. Users do not sign in.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr><th className="py-2">Name</th><th>Email</th><th>Notes</th><th /></tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-t">
              <td className="py-2 font-medium">{user.name}</td>
              <td>{user.email ?? '—'}</td>
              <td className="text-muted-foreground">{user.notes ?? '—'}</td>
              <td className="text-right">
                <form action={deleteUserAction}>
                  <input type="hidden" name="id" value={user.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {users.length === 0 ? (
            <tr><td colSpan={4} className="py-6 text-muted-foreground">No users yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <form action={createUserAction} className="flex flex-wrap items-end gap-2 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" />
        </div>
        <Button type="submit">Add user</Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 6: Write `src/app/(admin)/keys/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import { createApiKey, deleteApiKey, setApiKeyEnabled } from '@/lib/admin/keys'

export interface CreateKeyState {
  error?: string
  plaintextKey?: string
}

function optionalInt(formData: FormData, field: string): number | null {
  const value = formData.get(field)
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : null
}

function optionalText(formData: FormData, field: string): string | null {
  const value = formData.get(field)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export async function createKeyAction(
  _prev: CreateKeyState | undefined,
  formData: FormData,
): Promise<CreateKeyState> {
  await requireAdmin()
  const expiresAtRaw = optionalText(formData, 'expiresAt')

  try {
    const { plaintextKey } = await createApiKey({
      name: String(formData.get('name') ?? ''),
      userId: optionalText(formData, 'userId'),
      rpmLimit: optionalInt(formData, 'rpmLimit'),
      tpmLimit: optionalInt(formData, 'tpmLimit'),
      budgetMonthlyUsd: optionalText(formData, 'budgetMonthlyUsd'),
      budgetTotalUsd: optionalText(formData, 'budgetTotalUsd'),
      expiresAt: expiresAtRaw ? new Date(expiresAtRaw) : null,
    })
    revalidatePath('/keys')
    return { plaintextKey }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the key.' }
  }
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await setApiKeyEnabled(String(formData.get('id')), formData.get('enabled') === 'true')
  revalidatePath('/keys')
}

export async function deleteKeyAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteApiKey(String(formData.get('id')))
  revalidatePath('/keys')
}
```

- [ ] **Step 7: Write `src/app/(admin)/keys/key-form.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createKeyAction, type CreateKeyState } from './actions'

export function CreateKeyForm({ users }: { users: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<CreateKeyState | undefined, FormData>(
    createKeyAction, undefined,
  )

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Create an API key</h2>

      <form action={action} className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="production app" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="userId">User</Label>
          <select id="userId" name="userId" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
            <option value="">Unassigned</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="expiresAt">Expires</Label>
          <Input id="expiresAt" name="expiresAt" type="date" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rpmLimit">Requests / min</Label>
          <Input id="rpmLimit" name="rpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpmLimit">Tokens / min</Label>
          <Input id="tpmLimit" name="tpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="budgetMonthlyUsd">Monthly budget (USD)</Label>
          <Input id="budgetMonthlyUsd" name="budgetMonthlyUsd" type="number" step="0.01" min={0} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</Button>
        </div>
      </form>

      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}

      {state?.plaintextKey ? (
        <div className="space-y-1 rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">Copy this key now — it is never shown again.</p>
          <code className="block break-all font-mono text-sm">{state.plaintextKey}</code>
        </div>
      ) : null}
    </div>
  )
}
```

Rate and budget limits are captured here but not yet enforced — enforcement arrives in Phase 4. The page states this so nobody assumes a limit is active.

- [ ] **Step 8: Write `src/app/(admin)/keys/page.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listApiKeys, listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { deleteKeyAction, revokeKeyAction } from './actions'
import { CreateKeyForm } from './key-form'

export const dynamic = 'force-dynamic'

export default async function KeysPage() {
  await requireAdmin()
  const [keys, users] = await Promise.all([listApiKeys(), listUsers()])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Rate limits and budgets are recorded but not enforced until Phase 4.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Name</th><th>Key</th><th>User</th>
            <th>Limits</th><th>Last used</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-t">
              <td className="py-2 font-medium">{key.name}</td>
              <td className="font-mono text-xs">{key.keyPrefix}…</td>
              <td>{key.userName ?? '—'}</td>
              <td className="text-xs text-muted-foreground">
                {[key.rpmLimit && `${key.rpmLimit} rpm`,
                  key.tpmLimit && `${key.tpmLimit} tpm`,
                  key.budgetMonthlyUsd && `$${key.budgetMonthlyUsd}/mo`]
                  .filter(Boolean).join(' · ') || 'none'}
              </td>
              <td>{key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : 'never'}</td>
              <td><Badge variant={key.enabled ? 'default' : 'secondary'}>{key.enabled ? 'active' : 'revoked'}</Badge></td>
              <td className="space-x-1 text-right">
                <form action={revokeKeyAction} className="inline">
                  <input type="hidden" name="id" value={key.id} />
                  <input type="hidden" name="enabled" value={String(!key.enabled)} />
                  <Button type="submit" variant="ghost" size="sm">
                    {key.enabled ? 'Revoke' : 'Restore'}
                  </Button>
                </form>
                <form action={deleteKeyAction} className="inline">
                  <input type="hidden" name="id" value={key.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {keys.length === 0 ? (
            <tr><td colSpan={7} className="py-6 text-muted-foreground">No API keys yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <CreateKeyForm users={users} />
    </div>
  )
}
```

- [ ] **Step 9: Verify by hand**

Run `pnpm dev`, add a user, create a key assigned to them.
Expected: the plaintext key is shown once; reloading the page shows only the prefix.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: user and API key management"
```

---

## Task 17: OpenAI client contract test

**Files:**
- Test: `tests/contract/openai-client.test.ts`

**Interfaces:**
- Consumes: `handleChatCompletions` (Tasks 11–12), the real `openai` package
- Produces: nothing — this task proves the claim "OpenAI-compatible"

The real SDK is pointed at the handler through a custom `fetch`. That exercises the SDK's own request building, response parsing, SSE decoding, and error classes against our implementation — the parts a hand-rolled test would quietly skip.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/openai-client.test.ts
import { beforeEach, expect, test } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import type { ProviderAdapter } from '@/lib/adapters/types'
import { seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-tool-call-stream.json'

const completion = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1', type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
}

function gatewayClient(apiKey: string, adapter: Partial<ProviderAdapter>) {
  const deps = {
    createAdapter: () => ({
      async chat() { throw new Error('chat not stubbed') },
      async *chatStream() { throw new Error('chatStream not stubbed') },
      ...adapter,
    }) as ProviderAdapter,
  }

  return new OpenAI({
    apiKey,
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    fetch: ((url: string, init?: RequestInit) =>
      handleChatCompletions(new Request(url, init), deps)) as unknown as typeof fetch,
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '3'.repeat(64)
  await resetDb()
})

test('the SDK completes a non-streaming tool call', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, { chat: async () => completion as never })

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  })

  expect(result.model).toBe('house-model')
  const call = result.choices[0].message.tool_calls?.[0]
  expect(call?.function.name).toBe('get_weather')
  expect(JSON.parse(call!.function.arguments)).toEqual({ city: 'Paris' })
  expect(result.usage?.total_tokens).toBe(52)
})

test('the SDK consumes the stream and reassembles tool call arguments', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {
    chatStream: (async function* () {
      for (const chunk of fixture) yield chunk
    }) as never,
  })

  const stream = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    stream: true,
  })

  let args = ''
  let finishReason: string | null | undefined
  let totalTokens: number | undefined
  const models = new Set<string>()

  for await (const chunk of stream) {
    models.add(chunk.model)
    for (const call of chunk.choices[0]?.delta?.tool_calls ?? []) {
      args += call.function?.arguments ?? ''
    }
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason
    totalTokens = chunk.usage?.total_tokens ?? totalTokens
  }

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  expect(finishReason).toBe('tool_calls')
  expect(totalTokens).toBe(52)
  expect([...models]).toEqual(['house-model'])
})

test('the SDK raises AuthenticationError for a bad key', async () => {
  await seedGateway()
  const client = gatewayClient('sk-bab-wrong', {})

  await expect(
    client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.AuthenticationError)
})

test('the SDK raises NotFoundError for an unknown virtual model', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {})

  await expect(
    client.chat.completions.create({
      model: 'does-not-exist',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.NotFoundError)
})

test('the SDK surfaces an upstream rate limit as RateLimitError', async () => {
  const { apiKey } = await seedGateway()
  const client = gatewayClient(apiKey, {
    chat: async () => {
      throw new OpenAI.APIError(429, { error: { message: 'slow down' } }, 'slow down', undefined)
    },
  })

  await expect(
    client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toBeInstanceOf(OpenAI.RateLimitError)
})
```

- [ ] **Step 2: Run to verify it fails or passes for the right reasons**

Run: `pnpm test tests/contract/openai-client.test.ts`
Expected: initially FAIL if any error status or SSE detail is wrong. Fix the handler, not the test — the SDK's expectations are the specification here.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test`
Expected: PASS, every suite green.

- [ ] **Step 4: Verify the build and type check**

```bash
pnpm build
pnpm lint
```

Expected: both succeed with no errors.

- [ ] **Step 5: End-to-end check against a real provider**

With `pnpm dev` running and a real OpenAI provider plus a `house-model` virtual model configured:

```bash
curl -sS http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <the key you created>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"house-model","messages":[{"role":"user","content":"say hi"}]}' | jq

curl -sS -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <the key you created>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"house-model","messages":[{"role":"user","content":"count to 5"}],"stream":true}'
```

Expected: the first returns JSON with `"model":"house-model"`; the second streams `data:` lines ending in `data: [DONE]`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: OpenAI client contract test for streaming, tools, and errors"
```

---

## Phase 1 Done When

- `pnpm test` is green and `pnpm build` succeeds.
- An admin can sign in, add a provider, define a virtual model with a target, and issue a key.
- The real `openai` npm client, pointed at the gateway, completes both a streaming and a non-streaming tool call.
- No secret is ever rendered to the browser after creation.

Phase 2 (`failover, weighted, round robin, circuit breaker, request logs`) builds on `resolveVirtualModel`'s candidate list and `startChatStream`'s commit boundary — neither signature needs to change.

