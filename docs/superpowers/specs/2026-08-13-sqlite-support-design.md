# SQLite Support — design

**Issue #3.** Let a single-instance deployment run on SQLite instead of
Postgres, so a self-hoster has no external database service to provision, back
up or upgrade, and so the test suite stops requiring docker.

Postgres remains the default and the only supported multi-instance backend.

## 1. Problem

`src/lib/db/index.ts` hard-wires `pg` and `drizzle-orm/node-postgres`, and
`src/lib/db/schema.ts` is written entirely in `drizzle-orm/pg-core`. Running
the gateway therefore requires a Postgres server — for a one-person deployment
that is more operational surface than the gateway itself, and for development
it means `docker compose up` before any test can run.

Thirteen modules under `src/lib/**` import `@/lib/db`. All of them go through
Drizzle's query builder, with four exceptions that reach for Postgres
directly:

1. `src/lib/catalog/namespaces.ts:17` — `split_part` + `jsonb_object_keys`.
2. `src/lib/catalog/sync.ts:298` — `pg_try_advisory_lock` on a dedicated
   pooled connection.
3. `src/lib/catalog/sync.ts:257` — `db.transaction(async (tx) => …)`.
4. `tests/helpers/db.ts` — `TRUNCATE … RESTART IDENTITY CASCADE`, and
   `db.execute()`, which does not exist on a SQLite Drizzle database.

Those four are the whole of the porting problem. Everything else is column
types.

## 2. Scope

In scope:

- A second Drizzle schema in `sqlite-core`, mirroring the Postgres one.
- Dialect selection from the `DATABASE_URL` scheme.
- A second migrations folder and drizzle-kit config.
- Abstractions for the four Postgres-only call sites above.
- The existing test suite running against both dialects.
- Packaging: `better-sqlite3` as a production dependency, Dockerfile, compose
  profile, `.env.example`, README.

Out of scope: changing any query in the thirteen consumer modules; multi-instance
SQLite (it is a contradiction — see §4.3); migrating data between dialects;
per-test-file database isolation (§8.4); replacing Postgres anywhere.

## 3. Decisions

| Decision | Choice |
|---|---|
| Engine | Real SQLite, per the issue title. Not PGlite. |
| Driver | `better-sqlite3` + `drizzle-orm/better-sqlite3`. First-class Drizzle driver and migrator; prebuilt binaries for `node:22-bookworm-slim`. |
| Selection | `DATABASE_URL` scheme. `postgres:`/`postgresql:` → Postgres, `file:`/`sqlite:` → SQLite. No new env var. |
| Default | Postgres. `DATABASE_URL` stays required; unset or unrecognised throws. |
| Type strategy | One canonical type (Postgres), runtime-selected values, one documented cast. §4.2. |
| Drift guard | A reflection-based parity test over both schema modules. §8.3. |
| Timestamps | `integer({ mode: 'timestamp_ms' })`, defaulted in JS via `$defaultFn`. |
| Money columns | A `customType` over TEXT normalising to 6 decimals, **not** SQLite `numeric`. §4.1.1. |
| Enums | `text({ enum: [...] })`. No CHECK constraint; TypeScript-only, as today's app-level validation already carries the weight. |
| Test default | `pnpm test` → SQLite. `test:pg` → Postgres. `test:all` → both. |
| Test parallelism | Stays off. A shared SQLite file has the same cross-file race as the shared Postgres database. §8.4. |

### 3.1 Why one canonical type and a cast

Drizzle's table objects are dialect-specific: a query built from a `pg-core`
table emits Postgres SQL regardless of which database executes it. So the
tables and the database handle must be swapped **together** at runtime.

Making that visible in the type system would mean typing `db` as
`PgDatabase | BetterSQLite3Database` and every table as a union, which does not
typecheck against a single query — `db.select().from(providers)` has no
overload accepting a union of dialects. The alternatives were a generic
repository layer over all thirteen modules (a rewrite of the entire data
access layer, far beyond this issue) or a cast.

The cast is chosen, confined to one file, and backstopped by §8.3. It is sound
because the two schemas produce structurally identical row types — verified
against the installed Drizzle 0.45.2:

| Postgres | SQLite | Row type |
|---|---|---|
| `uuid().defaultRandom()` | `text().$defaultFn(randomUUID)` | `string` |
| `text()` | `text()` | `string` |
| `boolean()` | `integer({ mode: 'boolean' })` | `boolean` |
| `timestamp({ withTimezone: true })` | `integer({ mode: 'timestamp_ms' })` | `Date` |
| `jsonb().$type<T>()` | `text({ mode: 'json' }).$type<T>()` | `T` |
| `pgEnum(...)` | `text({ enum: [...] })` | the union |
| `numeric({ precision: 12, scale: 6 })` | `money()` custom type (§4.1.1) | `string` |
| `integer()` | `integer()` | `number` |

## 4. Components

### 4.1 `src/lib/db/schema.sqlite.ts` (new)

A mirror of `schema.pg.ts` in `sqlite-core`, table for table and column for
column, applying the mapping table above.

Two mappings are not mechanical and are specified below.

#### 4.1.1 Money columns

`api_keys.budget_total_usd`, `budget_monthly_usd`, `spend_total_usd` and
`catalog_models.input_per_mtok`, `output_per_mtok`, `cached_input_per_mtok`
are `numeric(12, 6)` on Postgres, which reads back **scale-formatted**:
`2.5` written returns `'2.500000'`. `tests/lib/catalog/sync.test.ts:92` and
`:226` assert exactly that string.

SQLite's `numeric()` is the wrong tool twice over: NUMERIC *affinity* coerces
a numeric-looking string to INTEGER or REAL, which is lossy for money, and it
preserves no scale, so `'2.5'` would come back and those assertions would fail.

Instead a shared `customType` stores TEXT and normalises on write:

```ts
const money = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  // Postgres numeric(12,6) reads back scale-formatted, and callers compare
  // these as strings. Normalising on write is what makes '2.500000' identical
  // across both dialects instead of a dialect-dependent '2.5'.
  toDriver: (value) => Number(value).toFixed(6),
})
```

There is no `fromDriver`: the value stored is already scale-formatted, so
reading returns the TEXT verbatim and `row.inputPerMtok` is `'2.500000'` on
both dialects. Normalising on write rather than read also means a value
inspected with the `sqlite3` CLI looks like its Postgres counterpart.

Max magnitude is `999999.999999` — twelve significant digits, comfortably
inside a double — so the `Number()` round-trip is exact.

#### 4.1.2 Timestamps and generated defaults

`integer({ mode: 'timestamp_ms' })` gives millisecond parity with
`timestamptz`; `mode: 'timestamp'` would truncate to seconds and make
`created_at` ordering ambiguous within a request.

Postgres `.defaultNow()` and `.defaultRandom()` are SQL-side defaults. SQLite
has no UUID function, and a millisecond-resolution SQL default requires
`unixepoch('subsec')`, whose availability depends on the bundled SQLite build.
Both therefore become Drizzle `$defaultFn` — applied in JS at insert time.

The consequence is explicit: **a row inserted by raw SQL, bypassing Drizzle,
gets no id and no timestamps on SQLite.** Every write in `src/lib/**` goes
through the query builder, so nothing today is affected; the parity test
records the mapping so a future raw-SQL insert is a deliberate choice.

### 4.2 `src/lib/db/dialect.ts` (new)

```ts
export type Dialect = 'postgres' | 'sqlite'
export function resolveDialect(url: string | undefined): Dialect
export function sqliteFilename(url: string): string
```

Pure and synchronous, so `scripts/migrate.mjs`, the Drizzle configs, the test
setup and the app all resolve identically, and so it is unit-testable without a
database. Unset, empty, or an unrecognised scheme throws a message naming the
accepted forms rather than defaulting.

`sqliteFilename` maps `file:./data/babellm.db` and `sqlite:./data/babellm.db`
to a filesystem path, and `:memory:` through unchanged.

### 4.3 `src/lib/db/index.ts`

Selects the driver, exports one Postgres-typed surface.

```ts
const dialect = resolveDialect(process.env.DATABASE_URL)
export const db = (dialect === 'sqlite' ? makeSqlite() : makePostgres()) as PgDb
export const pool: Pool | null   // postgres only
export { dialect, schema }
```

The SQLite handle sets `journal_mode = WAL` (concurrent readers alongside the
writer), `foreign_keys = ON` (off by default in SQLite, and the schema has four
FK relationships including two `onDelete` behaviours the app relies on), and
`busy_timeout = 5000` (matching the Postgres `connectionTimeoutMillis`).

The same `globalThis` cache guard used for the pool today applies to the SQLite
handle, for the same reason: hot reload must not open a second connection.

`pool` becomes `Pool | null`. Its only consumers are `sync.ts` — which stops
using it entirely under §4.4 — and `tests/lib/db/pool.test.ts`, which becomes
Postgres-only.

### 4.4 `src/lib/db/ops.ts` (new) — the four seams

One module holding every operation whose implementation differs, so the
dialect branch lives in exactly one place outside `index.ts`.

```ts
/** The busy sentinel. A unique symbol so no legitimate T can collide with it. */
export const LOCK_BUSY: unique symbol

export function withTransaction<T>(fn: (tx: PgTx) => Promise<T>): Promise<T>
export function tryLock<T>(name: string, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY>
export function queryRows<T>(pg: SQL, sqlite: SQL): Promise<T[]>
```

`PgDb` and `PgTx` are aliases for the Postgres database and transaction types
that `index.ts` already produces — the canonical types of §3.1, named once here
so the seams and the consumer modules agree on one vocabulary.

**`withTransaction`** — Postgres delegates to `db.transaction`. SQLite issues
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` around the callback by hand.

This is the subtlest part of the change and the reason it is not a one-liner:
`better-sqlite3`'s `transaction()` takes a **synchronous** callback and returns
`T` directly, not a promise. Handing it `async (tx) => …` — which is what
`sync.ts:257` does — would let it commit the moment the callback returns its
unresolved promise, landing every write *outside* the transaction. That is a
silent data-integrity bug, not a compile error, which is why the manual form is
used instead. It is safe here because `better-sqlite3` is a single connection
and a SQLite deployment is by definition one instance.

`ROLLBACK` runs in a `catch` that rethrows, so a failing sync leaves no partial
upsert. §8.2 covers this directly.

**`tryLock`** — Postgres keeps today's `pg_try_advisory_lock(hashtext($1))` on
a dedicated pooled client, including the existing unlock-failure handling that
destroys rather than recycles the client. SQLite uses an in-process
`Set<string>`.

An in-process mutex is not a weaker approximation here, it is exact: the lock
exists to stop two admins double-writing a sync, and SQLite means one process,
so process-local *is* global. The interface returns a busy sentinel rather than
throwing, matching how `syncProvider` already reports "a sync is already
running".

**`queryRows`** — takes both dialects' SQL and runs the right one, hiding that
Postgres exposes `.execute()` returning `{ rows }` while SQLite exposes
`.all()` and has no `.execute()` at all.

### 4.5 `src/lib/catalog/namespaces.ts`

`queryCachedSlugs` gains a SQLite branch through `queryRows`:

```sql
-- postgres (unchanged)
SELECT DISTINCT split_part(k, '/', 1) AS slug
FROM registry_cache, jsonb_object_keys(payload) k
WHERE k LIKE '%/%'

-- sqlite
SELECT DISTINCT substr(k.key, 1, instr(k.key, '/') - 1) AS slug
FROM registry_cache, json_each(registry_cache.payload) AS k
WHERE k.key LIKE '%/%'
```

The `LIKE '%/%'` guard carries the same load in both: `split_part` returns the
whole string when the delimiter is absent, and `instr` returns `0`, which would
make `substr(…, 1, -1)` return empty. Both would otherwise surface a malformed
key as a bogus namespace.

The 1.6 MB payload stays in the database in both dialects — `json_each` is the
SQLite equivalent of the reason this is SQL and not JavaScript.

The function's existing `opts.queryImpl` seam is untouched, so its six tests
keep working unchanged.

### 4.6 `src/lib/catalog/sync.ts`

Two edits, no behaviour change on Postgres:

- `db.transaction(async (tx) => …)` → `withTransaction(async (tx) => …)`.
- The `pool.connect()` / advisory-lock / `finally`-release block collapses into
  `tryLock(lockName, () => runSync(provider, options))`. The unlock and
  client-destruction handling moves into `ops.ts` verbatim; the busy branch
  keeps returning today's `'A sync is already running for this provider.'`.

The `import { pool }` goes away.

## 5. Migrations

`drizzle/` splits into `drizzle/pg/` and `drizzle/sqlite/`.

The two existing migrations and `meta/_journal.json` **move byte-identically**
into `drizzle/pg/`. Drizzle records applied migrations by content hash in
`__drizzle_migrations`, so an unchanged file at a new path is still recognised
as applied: **no deployed database re-runs anything, and no data is touched.**
Verifying this against a database migrated before the change is an acceptance
criterion, not an assumption.

`drizzle/sqlite/` is generated fresh — a SQLite deployment starts empty by
definition, so it needs one initial migration, not a replay of the Postgres
history.

| Command | Was | Becomes |
|---|---|---|
| `db:generate` | drizzle-kit generate | `db:generate:pg`, `db:generate:sqlite` |
| `db:migrate` | drizzle-kit migrate | `db:migrate:pg`, `db:migrate:sqlite` |
| `db:deploy` | `node scripts/migrate.mjs` | unchanged — branches internally |

Two configs (`drizzle.config.pg.ts`, `drizzle.config.sqlite.ts`), each pinning
its dialect, schema file and output folder.

**Both must be generated for every future schema change.** That is the standing
cost of this issue, and §8.3 is what makes forgetting it a failing test rather
than a production error.

`scripts/migrate.mjs` calls `resolveDialect` and picks its migrator and folder.
Its existing constraints hold: no dotenv, and only production dependencies —
`better-sqlite3` is one, so this still works against the pruned
`node_modules` in the runtime image.

## 6. Data flow

```
DATABASE_URL
  └─ resolveDialect()
       ├─ 'postgres' → Pool + drizzle/node-postgres + schema.pg.ts   → drizzle/pg/
       └─ 'sqlite'   → better-sqlite3 + drizzle/better-sqlite3
                       + schema.sqlite.ts (WAL, FK on, busy_timeout) → drizzle/sqlite/
                            │
                    db (typed as the Postgres database)
                            │
        ┌───────────────────┼────────────────────┐
   13 consumer modules   ops.ts              schema.ts
   (unchanged)          withTransaction      runtime-selected values,
                        tryLock              Postgres types
                        queryRows
```

## 7. Error handling

| Failure | Behaviour |
|---|---|
| `DATABASE_URL` unset or unrecognised scheme | `resolveDialect` throws at startup, naming the accepted forms. No silent default. |
| SQLite file's directory missing | Created on boot before opening, so `file:./data/babellm.db` works on a fresh checkout. |
| SQLite file unwritable | `better-sqlite3` throws at open; startup fails loudly rather than degrading. |
| Concurrent sync, SQLite | `tryLock` returns busy; the existing "already running" message is shown. |
| Transaction body throws, SQLite | `ROLLBACK`, then rethrow. No partial upsert. |
| `registry_cache` query fails, either dialect | Unchanged: caught in `listRegistryNamespaces`, degrades to seed-only. |
| Postgres pool idle-client error | Unchanged. The listener in `index.ts` stays on the Postgres branch. |

## 8. Testing

### 8.1 Both dialects, same suite

`DATABASE_URL` parameterises the run.

| Script | Target |
|---|---|
| `pnpm test` | SQLite, temp file. No docker. |
| `pnpm test:pg` | Postgres, as today. |
| `pnpm test:all` | Both, sequentially. |

`tests/setup/global-setup.ts` branches: Postgres keeps its `CREATE DATABASE`
probe; SQLite deletes any stale file and runs the SQLite migrator.

`tests/helpers/db.ts` swaps `TRUNCATE … RESTART IDENTITY CASCADE` for
`DELETE FROM` per table inside `PRAGMA foreign_keys = OFF` / `ON`, and moves
off `db.execute()` onto `queryRows`.

`tests/lib/db/pool.test.ts` and the two `pool`-spying tests in
`tests/lib/catalog/sync.test.ts` (`:379`, `:429`) skip on SQLite — they assert
`pg`-pool mechanics that have no SQLite counterpart.

Every other test file is expected to pass **unchanged** on both dialects. Where
one does not, the first question is whether the schema mapping is wrong (fix
§4.1) before the test is touched — §4.1.1 exists precisely because that
question had a real answer.

### 8.2 New behavioural tests

- `tests/lib/db/dialect.test.ts` — every accepted scheme; unset, empty and
  `mysql://` throw; `sqliteFilename` on `file:`, `sqlite:` and `:memory:`.
- `tests/lib/db/ops.test.ts` — **`withTransaction` rolls back on throw**, which
  is the hand-rolled path and the one most likely to be wrong; `tryLock` denies
  a second concurrent holder and releases on both success and throw.
- `tests/lib/catalog/namespaces.test.ts` — the SQLite query against a real
  `registry_cache` row: slugs extracted, duplicates collapsed, a key with no
  `/` dropped, a key starting with `/` dropped.

### 8.3 The parity test

`tests/lib/db/schema-parity.test.ts` reflects over both schema modules and
asserts they agree on: table set, per-table column set, SQL column names,
nullability, primary keys, and unique/plain index names and their columns.

This is what keeps §3.1's cast honest. A column added to one dialect and not
the other fails here, at the point of the mistake, instead of in a user's
production query. It is the single most important test in this change.

A companion type-level assertion (`expectTypeOf<PgRow>().toEqualTypeOf<SqliteRow>()`
per table) catches mapping drift the runtime reflection cannot see — a
`timestamp` mapped to `integer({ mode: 'number' })` has the right column name
and nullability but the wrong TypeScript type.

### 8.4 What does not change

`fileParallelism` stays `false`. A shared SQLite file has exactly the
cross-file reset/insert race the comment in `vitest.config.ts` documents for
the shared Postgres database. Per-file database isolation would fix it for both
dialects and is worth doing, but it is a separate change — noted in §10.

## 9. Files touched

| File | Change |
|---|---|
| `src/lib/db/dialect.ts` | new — scheme resolution |
| `src/lib/db/schema.pg.ts` | today's `schema.ts`, moved verbatim |
| `src/lib/db/schema.sqlite.ts` | new — the mirror |
| `src/lib/db/schema.ts` | runtime selection, Postgres types |
| `src/lib/db/index.ts` | driver selection; `pool` becomes nullable |
| `src/lib/db/ops.ts` | new — the four seams |
| `src/lib/catalog/namespaces.ts` | SQLite branch for the slug query |
| `src/lib/catalog/sync.ts` | `withTransaction`, `tryLock`; drops `pool` |
| `drizzle/pg/**` | existing migrations moved byte-identically |
| `drizzle/sqlite/**` | new — initial migration |
| `drizzle.config.pg.ts`, `drizzle.config.sqlite.ts` | replace `drizzle.config.ts` |
| `scripts/migrate.mjs` | branch on dialect |
| `package.json` | `better-sqlite3` prod dep; per-dialect scripts |
| `pnpm-workspace.yaml` | `onlyBuiltDependencies: [better-sqlite3]` |
| `vitest.config.ts` | unchanged except comments |
| `tests/setup/global-setup.ts` | dialect branch |
| `tests/helpers/db.ts` | `DELETE FROM`; `queryRows` |
| `tests/lib/db/{dialect,ops,schema-parity}.test.ts` | new |
| `tests/lib/db/pool.test.ts`, `tests/lib/catalog/sync.test.ts` | skip 3 Postgres-only tests |
| `Dockerfile` | native module build |
| `docker-compose.yml` | Postgres-free profile |
| `.env.example`, `README.md` | both quickstarts |

### 9.1 Packaging note

pnpm 10 blocks dependency build scripts by default, and `better-sqlite3` needs
its postinstall to place the native binary. `pnpm-workspace.yaml` already
carries an `ignoredBuiltDependencies` list; it gains
`onlyBuiltDependencies: [better-sqlite3]`. Without it the Docker build produces
an unbuilt module that fails at require time, in the runtime stage, not the
build stage — a late and confusing failure.

The `prod-deps` stage must build it too, since `scripts/migrate.mjs` loads it
before the server starts.

## 10. Known follow-ups

**Per-test-file database isolation.** `fileParallelism: false` is a workaround
for a shared fixture, and it now costs on both dialects. SQLite makes the fix
cheap — a database file per worker is a path, not a `CREATE DATABASE` — and it
would let the suite parallelise on SQLite while leaving Postgres serialised.
Out of scope here because it changes how every test acquires its database.

**No CHECK constraints on SQLite enum columns.** `pgEnum` is enforced by
Postgres; `text({ enum })` is enforced only by TypeScript. Every write goes
through validated server actions, so this is not reachable today, but a
hand-written `UPDATE` could store a value the app cannot parse. Adding CHECK
constraints to the SQLite migration would close it.

**Postgres-only tests reduce SQLite's effective coverage by three.** The two
pool-mechanics tests and the pool listener test have no SQLite analogue. The
in-process lock in `ops.ts` is covered directly (§8.2), so the gap is narrow,
but it is a gap.
