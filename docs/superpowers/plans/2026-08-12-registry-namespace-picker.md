# Registry Namespace Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick a models.dev registry namespace when *creating* a provider, choosing from the namespaces the gateway already knows, and warn on `/providers` when a sync matched none of a provider's models.

**Architecture:** A new `listRegistryNamespaces()` reads distinct provider slugs out of the `registry_cache` payload with SQL and unions them with the vendored seed snapshot, which is the only source of display names. Both provider forms render a shared `<input list>` field pointing at one page-level `<datalist>`. `SyncSummary` gains a `matched` count so the providers page can say "0 of 12 matched models.dev".

**Tech Stack:** Next.js 16 (App Router, React Server Components, server actions), React 19, drizzle-orm 0.45 on node-postgres, Vitest against a real Postgres, Tailwind v4 + shadcn-style components on `@base-ui/react`.

**Spec:** `docs/superpowers/specs/2026-08-12-registry-namespace-picker-design.md`

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing App Router or server-action code. Do not assume APIs from memory.
- **No new dependencies.** The datalist is native HTML; nothing may be added to `package.json`.
- **No migration.** `matched` rides inside the existing `providers.last_sync_summary` JSONB column. Do not run `drizzle-kit generate`.
- **`normalize.ts` is untouched.** Namespace *matching* is out of scope; this plan only changes how a namespace is chosen, stored, and reported.
- **Tests run against a real database.** `pnpm test` needs Postgres up (`docker compose up -d`). Test files run serially by design (`vitest.config.ts`).
- **Run tests with the file path**, e.g. `pnpm test tests/lib/catalog/seed.test.ts`. `pnpm test` alone runs everything.
- **Commit after every task.** Each task below ends with a working tree that passes `pnpm test` and `pnpm lint`.
- **`AGENTS.md` / `CLAUDE.md` churn:** `next dev` rewrites a block in `AGENTS.md`. If it shows up dirty, commit it with your work rather than reverting it.
- **Comment style:** this codebase writes comments that explain *why*, in full sentences, above the code they describe. Match it. Do not add narrating comments that restate the line below them.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/catalog/types.ts` | Add `RegistryNamespace` — the shared shape, so `seed.ts` and `namespaces.ts` need not import each other. |
| `src/lib/catalog/seed.ts` | Add `loadSeedProviders()` — provider slugs + display names off the raw snapshot. |
| `src/lib/catalog/config.ts` | Add `parseRegistryNamespace()` — validate a namespace typed into a form. |
| `src/lib/catalog/namespaces.ts` (new) | `listRegistryNamespaces()` — the union of cache slugs and seed providers. |
| `src/lib/db/schema.ts` | Widen the `last_sync_summary` `$type<>` with optional `matched`. |
| `src/lib/catalog/sync.ts` | Count matches into `SyncSummary.matched`. |
| `src/lib/admin/providers.ts` | Widen `ProviderListItem.lastSyncSummary` with optional `matched`. |
| `src/app/(admin)/providers/registry-namespace-field.tsx` (new) | The shared datalist and the field that points at it. |
| `src/app/(admin)/providers/provider-form.tsx` | Render the field on create. |
| `src/app/(admin)/providers/edit-provider-form.tsx` | Replace its bare input with the shared field. |
| `src/app/(admin)/providers/actions.ts` | Parse and persist the namespace on create; validate on update. |
| `src/app/(admin)/providers/page.tsx` | Render the datalist once; show the zero-match warning. |

---

### Task 1: Seed provider namespaces

The picker needs display names (`xai` → "xAI"). `loadSeed()` returns the *projected* index, which has already thrown provider metadata away, so the names must come off the raw snapshot.

**Files:**
- Modify: `src/lib/catalog/types.ts` (append)
- Modify: `src/lib/catalog/seed.ts`
- Test: `tests/lib/catalog/seed.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `interface RegistryNamespace { slug: string; name: string | null }` from `@/lib/catalog/types`; `loadSeedProviders(): RegistryNamespace[]` from `@/lib/catalog/seed`, sorted by slug ascending, memoized.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/catalog/seed.test.ts`, and add `loadSeedProviders` to the existing import from `@/lib/catalog/seed` on line 2:

```ts
test('the snapshot exposes its provider namespaces with display names', () => {
  const namespaces = loadSeedProviders()

  expect(namespaces.length).toBeGreaterThan(100)
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
  expect(namespaces).toContainEqual({ slug: 'openai', name: 'OpenAI' })
})

test('provider namespaces come back sorted, so the picker lists them predictably', () => {
  const slugs = loadSeedProviders().map((namespace) => namespace.slug)

  expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)))
})

test('loading providers is memoized like the index it sits beside', () => {
  expect(loadSeedProviders()).toBe(loadSeedProviders())
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/catalog/seed.test.ts`
Expected: FAIL — `loadSeedProviders is not a function` (or a TypeScript/import error naming the missing export).

- [ ] **Step 3: Add the shared type**

Append to `src/lib/catalog/types.ts`:

```ts
/** One models.dev provider namespace, as offered by the admin picker. */
export interface RegistryNamespace {
  slug: string
  /** Display name from the vendored snapshot. Null for a cache-only slug. */
  name: string | null
}
```

- [ ] **Step 4: Implement `loadSeedProviders`**

Rewrite `src/lib/catalog/seed.ts` as:

```ts
import { projectModelsDev, type RegistryIndex } from './registry'
import type { RegistryNamespace } from './types'
import snapshot from './seed/models.json'

let cached: RegistryIndex | null = null
let cachedProviders: RegistryNamespace[] | null = null

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

/**
 * The provider namespaces the snapshot knows, with their display names. The
 * projection behind loadSeed() keeps only `slug/modelId` keys and discards
 * provider metadata, so the names have to be read off the raw document here.
 */
export function loadSeedProviders(): RegistryNamespace[] {
  cachedProviders ??= Object.entries(snapshot as Record<string, unknown>)
    .map(([slug, provider]): RegistryNamespace => {
      const name = (provider as { name?: unknown } | null)?.name
      return { slug, name: typeof name === 'string' ? name : null }
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))

  return cachedProviders
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/catalog/seed.test.ts`
Expected: PASS — 7 tests (4 existing, 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/catalog/types.ts src/lib/catalog/seed.ts tests/lib/catalog/seed.test.ts
git commit -m "feat(catalog): read provider namespaces and display names off the seed"
```

---

### Task 2: Validate a typed namespace

A models.dev provider slug is a single path segment. In the key `anyapi/xai/grok-4.3` the slug is `anyapi` and `xai/grok-4.3` is the model id — so a namespace carrying a slash or a space can never match anything, and `xai/` would quietly build `xai//grok-4.3` and enrich nothing. That silent failure is the whole reason this feature exists, so it fails loudly at save time.

**Files:**
- Modify: `src/lib/catalog/config.ts`
- Test: `tests/lib/catalog/config.test.ts` (create — `config.ts` has no tests today)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRegistryNamespace(raw: string): string | null` from `@/lib/catalog/config`. Returns `null` for blank or whitespace-only input, the trimmed value otherwise, and throws an `Error` when the value contains whitespace or `/`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/catalog/config.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  parseProviderConfig, parseRegistryNamespace, readRegistryNamespace,
} from '@/lib/catalog/config'

test('a blank namespace means "no namespace"', () => {
  expect(parseRegistryNamespace('')).toBeNull()
  expect(parseRegistryNamespace('   ')).toBeNull()
})

test('a namespace is trimmed before it is stored', () => {
  expect(parseRegistryNamespace('  xai  ')).toBe('xai')
})

test('a namespace carrying a slash is rejected rather than silently unmatchable', () => {
  expect(() => parseRegistryNamespace('xai/')).toThrow(/single models\.dev provider slug/)
  expect(() => parseRegistryNamespace('anyapi/xai')).toThrow()
})

test('a namespace carrying whitespace is rejected', () => {
  expect(() => parseRegistryNamespace('amazon bedrock')).toThrow()
})

test('readRegistryNamespace reads the key out of a stored config', () => {
  expect(readRegistryNamespace('{"registryNamespace":"xai"}')).toBe('xai')
  expect(readRegistryNamespace('{}')).toBeNull()
  expect(readRegistryNamespace('not json at all')).toBeNull()
  expect(readRegistryNamespace('{"registryNamespace":42}')).toBeNull()
})

test('a config body that is not an object reads as empty', () => {
  expect(parseProviderConfig('null')).toEqual({})
  expect(parseProviderConfig('3')).toEqual({})
  expect(parseProviderConfig('{"timeoutMs":1000}')).toEqual({ timeoutMs: 1000 })
  expect(readRegistryNamespace('[]')).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/catalog/config.test.ts`
Expected: FAIL — `parseRegistryNamespace is not a function` (the `readRegistryNamespace` and `parseProviderConfig` cases would pass on their own).

- [ ] **Step 3: Implement the validator**

Append to `src/lib/catalog/config.ts`:

```ts
/**
 * Validates a namespace typed into a provider form. A models.dev provider slug
 * is a single path segment — in the key `anyapi/xai/grok-4.3` the slug is
 * `anyapi` and the rest is the model id — so a value carrying a slash or a
 * space can never match. `xai/` would quietly build `xai//grok-4.3` and enrich
 * nothing, which is exactly the silent failure this field exists to prevent.
 */
export function parseRegistryNamespace(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (/[\s/]/.test(value)) {
    throw new Error(
      `"${value}" is not a valid registry namespace: it must be a single models.dev provider slug, with no slashes or spaces.`,
    )
  }

  return value
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/config.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/config.ts tests/lib/catalog/config.test.ts
git commit -m "feat(catalog): validate a registry namespace typed into a form"
```

---

### Task 3: The namespace list

**Files:**
- Create: `src/lib/catalog/namespaces.ts`
- Test: `tests/lib/catalog/namespaces.test.ts` (create)

**Interfaces:**
- Consumes: `loadSeedProviders()` and `RegistryNamespace` from Task 1.
- Produces: `listRegistryNamespaces(opts?: { queryImpl?: () => Promise<string[]> }): Promise<RegistryNamespace[]>` from `@/lib/catalog/namespaces`. Never throws. Sorted by slug ascending. A slug present in both sources appears once, keeping its seed name.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/catalog/namespaces.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/lib/db'
import { registryCache } from '@/lib/db/schema'
import { listRegistryNamespaces } from '@/lib/catalog/namespaces'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  await resetDb()
})

const URL = 'https://models.dev/api.json'

async function cacheKeys(keys: string[]) {
  await db.insert(registryCache).values({
    url: URL,
    payload: Object.fromEntries(keys.map((key) => [key, {}])),
  })
}

test('an empty cache still offers every namespace the snapshot knows', async () => {
  const namespaces = await listRegistryNamespaces()

  expect(namespaces.length).toBeGreaterThan(100)
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
})

test('a namespace only the live cache knows is offered, without a name', async () => {
  await cacheKeys(['brand-new-co/model-1', 'xai/grok-9'])

  expect(await listRegistryNamespaces()).toContainEqual({ slug: 'brand-new-co', name: null })
})

test('a namespace in both sources appears once, keeping its display name', async () => {
  await cacheKeys(['xai/grok-9'])

  const namespaces = await listRegistryNamespaces()

  expect(namespaces.filter((namespace) => namespace.slug === 'xai'))
    .toEqual([{ slug: 'xai', name: 'xAI' }])
})

test('a key with no slash is not offered as a namespace', async () => {
  // split_part returns the whole string when the delimiter is absent, so
  // without a guard this key would surface as a namespace of its own.
  await cacheKeys(['no-slash-key', '/leading-slash'])

  const slugs = (await listRegistryNamespaces()).map((namespace) => namespace.slug)

  expect(slugs).not.toContain('no-slash-key')
  expect(slugs).not.toContain('')
})

test('namespaces come back sorted by slug', async () => {
  await cacheKeys(['zzz-last/model', 'aaa-first/model'])

  const slugs = (await listRegistryNamespaces()).map((namespace) => namespace.slug)

  expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)))
})

test('a failing cache query degrades to the snapshot instead of throwing', async () => {
  // The providers page must render even when this query cannot.
  const queryImpl = vi.fn().mockRejectedValue(new Error('relation does not exist'))

  const namespaces = await listRegistryNamespaces({ queryImpl })

  expect(queryImpl).toHaveBeenCalled()
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
  expect(namespaces.length).toBeGreaterThan(100)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/lib/catalog/namespaces.test.ts`
Expected: FAIL — cannot resolve `@/lib/catalog/namespaces`.

- [ ] **Step 3: Implement the loader**

Create `src/lib/catalog/namespaces.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { loadSeedProviders } from './seed'
import type { RegistryNamespace } from './types'

/**
 * Slugs the live registry has actually seen. Read with SQL rather than by
 * pulling `payload` into Node: the projected document is ~1.6 MB and only the
 * ~180 short slugs inside it are wanted.
 *
 * The LIKE guard is load-bearing. split_part returns the whole string when the
 * delimiter is absent, so a malformed key would otherwise come back as a
 * namespace of its own.
 */
async function queryCachedSlugs(): Promise<string[]> {
  const result = await db.execute<{ slug: string }>(sql`
    SELECT DISTINCT split_part(k, '/', 1) AS slug
    FROM registry_cache, jsonb_object_keys(payload) k
    WHERE k LIKE '%/%'
  `)

  return result.rows.map((row) => row.slug)
}

/**
 * Every namespace the provider picker offers: whatever the live cache has seen,
 * unioned with the vendored snapshot. The snapshot is the only source of
 * display names — the cached payload is the projected index, which keeps
 * `slug/modelId` keys and nothing else — so a slug only the cache knows comes
 * back nameless.
 *
 * Every row is read rather than only the active registry URL's: this is a list
 * of suggestions, where being generous beats being precise, and a free-form
 * value is accepted anyway.
 *
 * Never throws. `/providers` has to render even if this query does not, so a
 * failure degrades to the snapshot alone.
 */
export async function listRegistryNamespaces(
  opts: { queryImpl?: () => Promise<string[]> } = {},
): Promise<RegistryNamespace[]> {
  const byslug = new Map<string, string | null>()
  for (const { slug, name } of loadSeedProviders()) byslug.set(slug, name)

  try {
    for (const slug of await (opts.queryImpl ?? queryCachedSlugs)()) {
      // A key starting with "/" still yields an empty slug the guard cannot
      // catch. Seed names win, so a slug already present is left alone.
      if (slug && !byslug.has(slug)) byslug.set(slug, null)
    }
  } catch (err) {
    console.error('[catalog] could not read namespaces from the registry cache', err)
  }

  return [...byslug]
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/lib/catalog/namespaces.test.ts`
Expected: PASS — 6 tests. The failing-query test prints one `[catalog] could not read namespaces…` line to stderr; that is the code under test doing its job.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog/namespaces.ts tests/lib/catalog/namespaces.test.ts
git commit -m "feat(catalog): list the registry namespaces a provider can use"
```

---

### Task 4: Count registry matches during sync

**Files:**
- Modify: `src/lib/db/schema.ts:34-36`
- Modify: `src/lib/catalog/sync.ts:19-24` (the `SyncSummary` interface) and `src/lib/catalog/sync.ts:206-247` (the counting loop) and `:270-277` (the returned summary)
- Test: `tests/lib/catalog/sync.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SyncSummary` gains a required `matched: number`. Every `SyncResult.summary` written from now on carries it; rows written before this change do not, which is why every *reader* types it optional.

- [ ] **Step 1: Update the four existing summary assertions**

These use `toEqual`, so they break the moment a key is added. In `tests/lib/catalog/sync.test.ts`, the test registry index holds only `openai/gpt-4o`, and the seed has no `openai/whisper-1` or `openai/gpt-4.5-preview` — so exactly the `gpt-4o` rows match.

- Line 64: `expect(result.summary).toEqual({ added: 2, updated: 0, missing: 0, total: 2, matched: 1 })`
- Line 143: `expect(result.summary).toEqual({ added: 0, updated: 1, missing: 0, total: 1, matched: 1 })`
- Line 152: `expect(result.summary).toEqual({ added: 0, updated: 1, missing: 1, total: 1, matched: 1 })`
- Line 176: `expect(result.summary).toEqual({ added: 1, updated: 0, missing: 0, total: 1, matched: 1 })`

- [ ] **Step 2: Write the failing tests**

Add a helper beside the existing `makeProvider` in `tests/lib/catalog/sync.test.ts`:

```ts
/**
 * openai_compatible is the adapter with no default namespace, which is the
 * whole reason the match count exists.
 */
async function makeCompatibleProvider(config = '{}') {
  const [row] = await db.insert(providers).values({
    name: 'grok',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    credentials: encryptJson({ apiKey: 'sk-test' }),
    config,
  }).returning()
  return row
}
```

Then append these tests:

```ts
test('the summary counts how many models matched the registry', async () => {
  const provider = await makeProvider()
  const result = await syncProvider(provider.id, opts(adapterListing(['gpt-4o', 'whisper-1'])))

  expect(result.summary).toEqual({ added: 2, updated: 0, missing: 0, total: 2, matched: 1 })
})

test('a provider with no usable namespace matches nothing', async () => {
  const provider = await makeCompatibleProvider()
  const result = await syncProvider(provider.id, opts(adapterListing(['grok-4.3', 'grok-4.5'])))

  expect(result.summary).toMatchObject({ total: 2, matched: 0 })
  expect((await rowsFor(provider.id)).every((row) => row.canonicalKey === null)).toBe(true)
})

test('a namespace in the provider config makes its models match', async () => {
  const provider = await makeCompatibleProvider(JSON.stringify({ registryNamespace: 'xai' }))
  const result = await syncProvider(provider.id, opts(adapterListing(['grok-4.3', 'not-a-model'])))

  expect(result.summary).toMatchObject({ total: 2, matched: 1 })

  const [row] = (await rowsFor(provider.id)).filter((r) => r.modelId === 'grok-4.3')
  expect(row.canonicalKey).toBe('xai/grok-4.3')
  expect(row.inputPerMtok).not.toBeNull()
})
```

The last test matches through the *seed*, not the injected test registry — the vendored snapshot carries `xai/grok-4.3` with real pricing.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/lib/catalog/sync.test.ts`
Expected: FAIL — the new and updated `toEqual` assertions report a missing `matched` key; TypeScript flags `matched` as not present on `SyncSummary`.

- [ ] **Step 4: Widen the schema type**

In `src/lib/db/schema.ts`, replace the `lastSyncSummary` column type:

```ts
  lastSyncSummary: jsonb('last_sync_summary').$type<{
    added: number; updated: number; missing: number; total: number
    // Optional because rows written before match counting existed have no
    // count, and must not be read as "matched nothing".
    matched?: number
  } | null>(),
```

This is a TypeScript-level change to a `jsonb` column. Do **not** generate a migration.

- [ ] **Step 5: Count matches in the sync**

In `src/lib/catalog/sync.ts`, add the field to `SyncSummary`:

```ts
export interface SyncSummary {
  added: number
  updated: number
  missing: number
  total: number
  /** How many of `total` resolved to a models.dev entry. */
  matched: number
}
```

In `runSync`, add the counter beside the existing ones:

```ts
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let matched = 0
```

Increment it right after the canonical key is resolved, inside the `flatMap`:

```ts
    const canonicalKey = matchCanonicalKey(
      provider.adapter, model.id, namespace, registry.index, seed,
    )
    if (canonicalKey) matched += 1
```

And carry it in the returned summary:

```ts
    summary: { added, updated, missing: missing.length, total: upserts.length, matched },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test tests/lib/catalog/sync.test.ts`
Expected: PASS — every existing test plus the 3 new ones.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`
Expected: PASS. `SyncSummary` is referenced by `providers/actions.ts` and `admin/providers.ts`; this catches any other `toEqual` on a summary.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts src/lib/catalog/sync.ts tests/lib/catalog/sync.test.ts
git commit -m "feat(catalog): count how many models a sync matched to the registry"
```

---

### Task 5: Warn when a sync matched nothing

**Files:**
- Modify: `src/lib/admin/providers.ts:34` (the `lastSyncSummary` field of `ProviderListItem`)
- Modify: `src/app/(admin)/providers/page.tsx:13-28` (`SyncStatus`)

**Interfaces:**
- Consumes: `SyncSummary.matched` from Task 4.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Widen the read type**

In `src/lib/admin/providers.ts`, replace the `lastSyncSummary` line of `ProviderListItem`:

```ts
  lastSyncSummary: {
    added: number; updated: number; missing: number; total: number; matched?: number
  } | null
```

`matched` is optional here even though `SyncSummary` requires it: this type describes what is *read back* from `last_sync_summary`, and a row written before Task 4 has no count.

- [ ] **Step 2: Render the match line**

In `src/app/(admin)/providers/page.tsx`, add above `SyncStatus`:

```tsx
/**
 * A summary written before match counting existed carries no count, and must
 * not be reported as zero matches — so an absent count renders nothing.
 */
function RegistryMatch({ matched, total }: { matched?: number; total: number }) {
  if (matched === undefined || total === 0 || matched === total) return null

  if (matched === 0) {
    return (
      <div className="text-destructive">
        ⚠ 0 of {total} matched models.dev — set a registry namespace to get pricing
        and context limits
      </div>
    )
  }

  return <div>{matched} of {total} matched models.dev</div>
}
```

Then, in `SyncStatus`, replace the `lastSyncStatus === 'ok'` branch:

```tsx
  if (provider.lastSyncStatus === 'ok' && provider.lastSyncSummary) {
    const { added, updated, missing, matched, total } = provider.lastSyncSummary
    return (
      <>
        synced {when} · +{added} new ~{updated} updated{missing > 0 ? ` !${missing} missing` : ''}
        <RegistryMatch matched={matched} total={total} />
      </>
    )
  }
```

- [ ] **Step 3: Verify it typechecks and lints**

Run: `pnpm lint && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: See it in the app**

Run: `pnpm dev`, open `/providers`, and click **Sync** on an `openai_compatible` provider that has no namespace (the `grok` provider is exactly this).
Expected: under its model count, `⚠ 0 of 12 matched models.dev — set a registry namespace to get pricing and context limits` in the destructive colour. A provider whose models all match shows no extra line.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/providers.ts "src/app/(admin)/providers/page.tsx"
git commit -m "feat(providers): warn when a sync matched no models.dev entries"
```

---

### Task 6: The shared namespace field

The module is marked `'use client'`. Neither export uses hooks, so it would *appear* not to need it — but the field imports `@/components/ui/input`, which wraps `@base-ui/react`, and `page.tsx` (a server component) imports the datalist from this same module. Marking the module client-side keeps that dependency out of the server graph entirely. The datalist renders static markup from serializable props, so nothing is lost.

**Files:**
- Create: `src/app/(admin)/providers/registry-namespace-field.tsx`

**Interfaces:**
- Consumes: `RegistryNamespace` from Task 1.
- Produces, all from `./registry-namespace-field`:
  - `REGISTRY_NAMESPACE_LIST_ID: string`
  - `RegistryNamespaceDatalist({ namespaces }: { namespaces: RegistryNamespace[] })`
  - `RegistryNamespaceField({ id, adapter, defaultValue }: { id: string; adapter: AdapterType; defaultValue?: string | null })` — renders an input named `registryNamespace`.

- [ ] **Step 1: Write the component**

Create `src/app/(admin)/providers/registry-namespace-field.tsx`:

```tsx
'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdapterType } from '@/lib/adapters/credentials'
import { REGISTRY_NAMESPACE } from '@/lib/catalog/normalize'
import type { RegistryNamespace } from '@/lib/catalog/types'

/**
 * The one datalist every namespace field points at. It is rendered once per
 * page rather than once per field: the edit form draws a field per provider
 * row, and repeating ~180 options down the table would be pure weight.
 */
export const REGISTRY_NAMESPACE_LIST_ID = 'registry-namespaces'

export function RegistryNamespaceDatalist({ namespaces }: { namespaces: RegistryNamespace[] }) {
  return (
    <datalist id={REGISTRY_NAMESPACE_LIST_ID}>
      {namespaces.map(({ slug, name }) => (
        // The name is the option's text rather than a `label` attribute, which
        // is the form browsers render most consistently.
        <option key={slug} value={slug}>{name}</option>
      ))}
    </datalist>
  )
}

/**
 * The models.dev namespace a provider's models are matched against. Free text
 * on purpose: the suggestion list is only as current as the last registry
 * fetch, so a namespace added upstream yesterday must still be typeable today.
 *
 * Inert unless a <RegistryNamespaceDatalist> is rendered somewhere on the same
 * page — the browser silently drops a `list` pointing at nothing.
 */
export function RegistryNamespaceField({ id, adapter, defaultValue }: {
  id: string
  adapter: AdapterType
  defaultValue?: string | null
}) {
  const fallback = REGISTRY_NAMESPACE[adapter]

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">Registry namespace</Label>
      <Input
        id={id}
        name="registryNamespace"
        list={REGISTRY_NAMESPACE_LIST_ID}
        defaultValue={defaultValue ?? ''}
        placeholder={fallback ?? 'xai'}
      />
      <p className="text-xs text-muted-foreground">
        models.dev namespace for enriching this provider&apos;s models with pricing and
        limits.{' '}
        {fallback
          ? <>Blank uses <code>{fallback}</code>.</>
          : <>This adapter has no default — blank means no enrichment.</>}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm lint && pnpm exec tsc --noEmit`
Expected: no errors. In particular `REGISTRY_NAMESPACE` must import cleanly — `normalize.ts` has no `server-only` import, so a client-side component may read it.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(admin)/providers/registry-namespace-field.tsx"
git commit -m "feat(providers): shared registry namespace field backed by a datalist"
```

---

### Task 7: Wire the field into both forms

This is the integration task: after it, creating a provider with a namespace enriches its models on the very first sync.

**Files:**
- Modify: `src/app/(admin)/providers/page.tsx`
- Modify: `src/app/(admin)/providers/provider-form.tsx`
- Modify: `src/app/(admin)/providers/edit-provider-form.tsx:43-54`
- Modify: `src/app/(admin)/providers/actions.ts`

**Interfaces:**
- Consumes: `listRegistryNamespaces()` (Task 3), `parseRegistryNamespace()` (Task 2), `RegistryNamespaceDatalist` / `RegistryNamespaceField` (Task 6).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Render the datalist on the page**

In `src/app/(admin)/providers/page.tsx`, add the imports:

```tsx
import { listRegistryNamespaces } from '@/lib/catalog/namespaces'
import { RegistryNamespaceDatalist } from './registry-namespace-field'
```

Replace the data fetch in `ProvidersPage`:

```tsx
  const [providers, namespaces] = await Promise.all([
    listProviders(),
    listRegistryNamespaces(),
  ])
```

And render the datalist once, immediately before `<ProviderForm />`:

```tsx
      <RegistryNamespaceDatalist namespaces={namespaces} />
      <ProviderForm />
```

- [ ] **Step 2: Add the field to the create form**

In `src/app/(admin)/providers/provider-form.tsx`, import it:

```tsx
import { RegistryNamespaceField } from './registry-namespace-field'
```

And add it as a third cell in the grid that already holds Name and Adapter, immediately after the adapter `<div>` and before that grid's closing `</div>`:

```tsx
        <RegistryNamespaceField id="registryNamespace" adapter={adapter} />
```

Because `adapter` is the form's state, its placeholder and help text update as the adapter select changes.

- [ ] **Step 3: Use the same field in the edit form**

In `src/app/(admin)/providers/edit-provider-form.tsx`, import it:

```tsx
import { RegistryNamespaceField } from './registry-namespace-field'
```

Replace the whole namespace `<div className="space-y-1">…</div>` block (lines 43-54, the one holding the `ns-${provider.id}` label, input and help text) with:

```tsx
          <RegistryNamespaceField
            id={`ns-${provider.id}`}
            adapter={provider.adapter}
            defaultValue={provider.registryNamespace}
          />
```

If `Label` or `Input` is left unused in this file afterwards, keep them — the credentials fieldset below still uses both. Run `pnpm lint` to confirm.

- [ ] **Step 4: Parse and persist on create**

In `src/app/(admin)/providers/actions.ts`, add to the imports:

```ts
import { parseRegistryNamespace } from '@/lib/catalog/config'
```

In `createProviderAction`, after the adapter check and before `createProvider` is called:

```ts
  let namespace: string | null
  try {
    namespace = parseRegistryNamespace(String(formData.get('registryNamespace') ?? ''))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid registry namespace.' }
  }

  let created
  try {
    created = await createProvider({
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      credentials: credentialsFrom(formData, adapter),
      // Set at create time so the sync this action fires can already enrich.
      config: namespace ? { registryNamespace: namespace } : {},
    })
  } catch (err) {
```

- [ ] **Step 5: Validate on update too**

In `updateProviderAction`, delete the line

```ts
  const namespace = String(formData.get('registryNamespace') ?? '').trim()
```

and put the parse inside the `try` that already returns `{ error }`, as its first statement:

```ts
  try {
    const namespace = parseRegistryNamespace(String(formData.get('registryNamespace') ?? ''))

    // registryNamespace is the only config key this form edits. Merge it onto
```

The rest of that block is unchanged: `if (namespace) config.registryNamespace = namespace` / `else delete config.registryNamespace` still reads correctly, now against `string | null` rather than `string`.

- [ ] **Step 6: Verify it typechecks and lints**

Run: `pnpm lint && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Verify the whole path in the app**

Run `pnpm dev` and, on `/providers`:

1. In **Add a provider**, choose adapter `openai_compatible`. The Registry namespace field shows placeholder `xai` and the text "This adapter has no default — blank means no enrichment."
2. Type `xa` into it. The browser offers `xai` (shown as "xAI") and other matching namespaces.
3. Switch the adapter to `openai`. The placeholder becomes `openai` and the help text becomes "Blank uses `openai`."
4. Create a real `openai_compatible` provider with namespace `xai`, base URL `https://api.x.ai/v1` and a working key. Expected: "Provider created.", and its row shows no zero-match warning.
5. Open `/catalog?provider=<id>`. Expected: `grok-4.3` and the other matched models now show a context window and in/out prices; expanding one reads `Matched xai/grok-4.3`.
6. Edit the provider, clear the namespace, save. Expected: the re-sync fires and the row now reads `⚠ 0 of N matched models.dev — …`.
7. Edit again, type `xai/` and save. Expected: the form reports `"xai/" is not a valid registry namespace: it must be a single models.dev provider slug, with no slashes or spaces.` and nothing is saved.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(admin)/providers/page.tsx" "src/app/(admin)/providers/provider-form.tsx" "src/app/(admin)/providers/edit-provider-form.tsx" "src/app/(admin)/providers/actions.ts"
git commit -m "feat(providers): pick a registry namespace when creating a provider"
```

---

### Task 8: Fix the provider that started this

The existing `grok` provider was created before any of this and still has `config = '{}'`.

**Files:** none — this is a UI action against the running app.

- [ ] **Step 1: Set its namespace**

With `pnpm dev` running, open `/providers`, expand **Edit** on `grok`, set Registry namespace to `xai`, and save. The action re-syncs on save.

- [ ] **Step 2: Verify the enrichment landed**

Run:

```bash
PGPASSWORD=babellm psql -h localhost -U babellm -d babellm \
  -c "select model_id, canonical_key, input_per_mtok, output_per_mtok, context_window from catalog_models order by model_id;"
```

Expected: 10 of the 12 rows now carry a `canonical_key` of `xai/<id>` with prices and a context window. `grok-4.6` and `grok-imagine-image-2.0` stay null — models.dev does not list them under `xai`, so they need per-field overrides on `/catalog` if you want prices for them.

Expected on `/providers`: `10 of 12 matched models.dev`, in muted text rather than the destructive colour.

---

## Verification

After Task 8:

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm test
```

Expected: clean lint, no type errors, all tests pass — including the 3 new files (`config.test.ts`, `namespaces.test.ts`) and the extended `seed.test.ts` and `sync.test.ts`.
