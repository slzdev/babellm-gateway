# Registry Namespace Picker — design

**Phase 1.5 follow-up.** A small addition to the Model Catalog, touching only the
provider admin forms and the sync summary.

## 1. Problem

A provider on the `openai_compatible` adapter has no default models.dev
namespace, by design: the endpoint behind it could be anything, so
`REGISTRY_NAMESPACE.openai_compatible` is `null`
(`src/lib/catalog/normalize.ts`). The namespace must instead be supplied per
provider as `config.registryNamespace`.

Only the **edit** form exposes that field. The **create** form does not, so
every `openai_compatible` provider is born without a namespace. Its first sync —
which the create action fires automatically — then runs with no namespace at
all: `canonicalKeyCandidates` builds zero candidate keys, `matchCanonicalKey`
returns `null`, and every discovered model is stored with `canonical_key = NULL`
and an empty `registry` blob. Nothing enriches it.

Observed on a real xAI provider: 12 models discovered, 12 rows with no price, no
context window, and no max output tokens, while `registry_cache` held
`xai/grok-4.3` with `inputPerMtok 1.25` / `outputPerMtok 2.5` the whole time. The
sync reported `ok`, because from its point of view it was.

Two failures compound here:

1. The namespace cannot be set at the moment it matters — before the first sync.
2. Nothing tells an admin that a sync matched nothing. The only signal is a
   per-model line inside a collapsed `<details>` on `/catalog`, which reads "No
   registry match — set a registry namespace on the provider". Nobody opens 12
   rows to discover a provider-level misconfiguration.

## 2. Scope

In scope:

- A registry-namespace field on the provider **create** form, with a list of
  known namespaces as suggestions.
- The same control on the **edit** form, replacing its bare text input.
- A provider-level warning when a sync matches nothing.

Out of scope: changing how namespaces are matched (`normalize.ts` is untouched);
scheduled sync; any change to the request path; guessing a namespace from the
base URL.

## 3. Decisions

| Decision | Choice |
|---|---|
| Control | Native `<input list>` + `<datalist>`. Type-to-filter, free-form value still accepted. |
| Why not a strict `<select>` | 183 options, and it cannot express a namespace models.dev has but the cache does not. |
| Why not a combobox | The repo has no combobox component and no `cmdk` dependency. Not worth a new one here. |
| Suggestion source | Live `registry_cache` slugs ∪ vendored seed slugs. Display names from the seed. |
| Cache read shape | `SELECT DISTINCT split_part(k,'/',1)` so the 1.6 MB payload stays in Postgres. |
| Failure mode | Never throws. A failed query degrades to seed-only. |
| Datalist rendering | One shared `<datalist>` per page, referenced by every field via a constant id. |
| Validation | Trim; empty means none; reject whitespace and `/`. |
| Zero-match signal | `SyncSummary` gains `matched`, surfaced on `/providers`. |
| Migration | None. `matched` rides in the existing `last_sync_summary` JSONB column. |

### Why free-form input survives

The namespace is matched against whatever the live registry holds, and the
suggestion list is only ever as current as the last fetch or the last
`pnpm seed:refresh`. A namespace that models.dev added yesterday must still be
enterable today. The list is a convenience, not a constraint — which is also why
a strict dropdown was rejected.

### Why the union, and why names come from the seed

The seed snapshot carries `{ id, name }` per provider, so it is the only source
of human-readable labels (`xai` → "xAI"); the projected registry cache drops
provider metadata entirely, keeping only `slug/modelId` keys. The seed alone
would go stale between refreshes, and the cache alone would lose the labels. The
union gives current slugs with labels wherever the seed knows one.

The query reads every `registry_cache` row rather than filtering to the active
registry URL. For a suggestion list, being generous beats being precise, and it
avoids a settings read on every `/providers` render.

## 4. Components

### 4.1 `src/lib/catalog/namespaces.ts` (new)

`RegistryNamespace` is declared in `src/lib/catalog/types.ts`, alongside
`CatalogFields` and the rest, so that `seed.ts` and `namespaces.ts` can both
name it without importing each other:

```ts
export interface RegistryNamespace {
  slug: string
  name: string | null
}
```

```ts
export async function listRegistryNamespaces(
  opts?: { queryImpl?: () => Promise<string[]> },
): Promise<RegistryNamespace[]>
```

Live slugs:

```sql
SELECT DISTINCT split_part(k, '/', 1) AS slug
FROM registry_cache, jsonb_object_keys(payload) k
WHERE k LIKE '%/%'
```

The `WHERE` clause matters: `split_part` returns the whole string when the
delimiter is absent, so without it a malformed key would surface as a bogus
namespace suggestion. A key that begins with `/` still yields an empty slug,
which is dropped in the merge.

Merges into a `Map<slug, name | null>` seeded from `loadSeedProviders()`, with
cache-only slugs added nameless, returned sorted by slug ascending.

Never throws: any error from the query is caught and the seed list is returned
on its own, because `/providers` must not fail to render over a suggestion list.
`queryImpl` exists so a test can exercise that branch, matching the injection
style already used by `createAdapterImpl` in `sync.ts` and `fetchImpl` in
`registry.ts`.

### 4.2 `src/lib/catalog/seed.ts`

Gains a second memoized export beside `loadSeed()`:

```ts
export function loadSeedProviders(): RegistryNamespace[]
```

It reads `{ id, name }` off the same `seed/models.json` snapshot that
`loadSeed()` projects. `loadSeed()` returns the projected `RegistryIndex`, which
has already discarded provider names, so the names must be read from the raw
snapshot. Putting this here keeps `seed/models.json` imported by exactly one
module.

### 4.3 `src/lib/catalog/config.ts`

Gains a pure validator beside `readRegistryNamespace`:

```ts
export function parseRegistryNamespace(raw: string): string | null
```

Trims; returns `null` for empty; throws on a value containing whitespace or `/`.
A models.dev provider slug never contains a slash — in a key like
`anyapi/xai/grok-4.3` the slug is `anyapi` and the rest is the model id — so
`xai/` would silently build `xai//grok-4.3` and match nothing. Failing loudly at
save time beats a silent empty catalog.

### 4.4 `src/app/(admin)/providers/registry-namespace-field.tsx` (new)

```ts
export const REGISTRY_NAMESPACE_LIST_ID = 'registry-namespaces'
export function RegistryNamespaceDatalist(props: { namespaces: RegistryNamespace[] }): JSX.Element
export function RegistryNamespaceField(props: {
  id: string
  adapter: AdapterType
  defaultValue?: string | null
}): JSX.Element
```

`RegistryNamespaceDatalist` renders the options once for the whole page:
`<option value={slug}>{name}</option>`. The name is the option's text content
rather than a `label` attribute, which is the form browsers render most
consistently.

`RegistryNamespaceField` renders a `<Label>`, an `<Input list={REGISTRY_NAMESPACE_LIST_ID}
name="registryNamespace">`, and the help text. Its placeholder is
`REGISTRY_NAMESPACE[adapter]`, falling back to `xai` when that is `null` — so
the placeholder always shows what leaving the field blank will do.
`normalize.ts` has no `server-only` import, so a client component may read
`REGISTRY_NAMESPACE` from it.

The field references the shared datalist by constant id instead of rendering its
own copy. The edit form renders one field per provider row, and 183 options per
row would multiply for no benefit. The coupling — the field is inert unless a
`RegistryNamespaceDatalist` is somewhere on the page — is documented on both
exports.

### 4.5 Forms and page

- `providers/page.tsx` calls `listRegistryNamespaces()` and renders
  `<RegistryNamespaceDatalist>` once. Neither form receives the list as a prop.
- `provider-form.tsx` gains `<RegistryNamespaceField>`, shown for every adapter.
  It is an override for `openai`, `gemini` and `bedrock`, and the only way to
  set a namespace for `openai_compatible`.
- `edit-provider-form.tsx` swaps its bare `<Input name="registryNamespace">` for
  the same component, so both forms filter against one list.

### 4.6 `providers/actions.ts`

Both actions call `parseRegistryNamespace`, replacing the inline `.trim()` in
`updateProviderAction`. `createProviderAction` passes
`config: namespace ? { registryNamespace: namespace } : {}` to `createProvider`,
which already accepts a `config` object — nothing below the action layer
changes. A validation error is returned as `{ error }` like any other create or
update failure.

Because the create action already syncs on success, a namespace set at create
time means pricing lands on the very first sync.

### 4.7 Zero-match warning

`SyncSummary` in `sync.ts` gains `matched: number`, incremented in the same
`flatMap` that builds the upserts, whenever `canonicalKey !== null`. It is
written into the existing `providers.last_sync_summary` JSONB column, so there
is no migration.

On the read side, `ProviderListItem.lastSyncSummary` types `matched` as
optional, and `SyncStatus` in `providers/page.tsx` renders nothing extra when it
is absent. A summary written before this change never counted matches, and must
not be reported as "0 matched".

| Condition | Rendered |
|---|---|
| `matched` absent | nothing (pre-existing row) |
| `matched === total` | nothing |
| `matched === 0 && total > 0` | ⚠ `0 of 12 matched models.dev — set a registry namespace to get pricing and context limits` |
| otherwise | `10 of 12 matched models.dev` |

## 5. Data flow

```
providers/page.tsx (server)
  └─ listRegistryNamespaces()
       ├─ SELECT DISTINCT split_part(...) FROM registry_cache   → live slugs
       └─ loadSeedProviders()                                   → slugs + names
     → <RegistryNamespaceDatalist> rendered once

ProviderForm / EditProviderForm (client)
  └─ <RegistryNamespaceField list=REGISTRY_NAMESPACE_LIST_ID>
     → formData.registryNamespace
       → parseRegistryNamespace()
         → config.registryNamespace
           → syncProvider() → canonicalKeyCandidates() → matched count
             → last_sync_summary → SyncStatus
```

## 6. Error handling

| Failure | Behaviour |
|---|---|
| `registry_cache` query fails | Caught; seed-only list returned. The page renders. |
| `registry_cache` empty (fresh install, registry disabled) | Seed-only list, 183 entries with names. |
| Namespace contains whitespace or `/` | Action returns `{ error }`. Nothing is saved. |
| Namespace is valid but matches no models.dev provider | Saved as typed. The sync reports `0 of N matched`. |
| Create succeeds, sync fails | Unchanged: `{ success, warning }`, as today. |

## 7. Testing

- `tests/lib/catalog/namespaces.test.ts` (new) — seed-only when the cache is
  empty; union adds a cache-only slug; a slug in both appears once, with its
  seed name; sorted ascending; a malformed key with no `/` is dropped; a
  throwing `queryImpl` degrades to seed-only.
- `tests/lib/catalog/seed.test.ts` — `loadSeedProviders()` returns 183 entries,
  includes `{ slug: 'xai', name: 'xAI' }`, and is memoized.
- `tests/lib/catalog/config.test.ts` (new — `config.ts` has no tests today) —
  `parseRegistryNamespace` trims, maps empty and whitespace-only to `null`, and
  throws on `/` and on interior whitespace.
- `tests/lib/catalog/sync.test.ts` — `matched` is `0` when the provider has no
  namespace and the ids cannot match; equals the number of matching ids when a
  namespace is set; `matched <= total` always.

## 8. Files touched

| File | Change |
|---|---|
| `src/lib/catalog/namespaces.ts` | new |
| `src/lib/catalog/types.ts` | `RegistryNamespace` |
| `src/lib/catalog/seed.ts` | `loadSeedProviders()` |
| `src/lib/catalog/config.ts` | `parseRegistryNamespace()` |
| `src/lib/catalog/sync.ts` | `SyncSummary.matched` |
| `src/lib/admin/providers.ts` | optional `matched` on the read type |
| `src/app/(admin)/providers/registry-namespace-field.tsx` | new |
| `src/app/(admin)/providers/provider-form.tsx` | add the field |
| `src/app/(admin)/providers/edit-provider-form.tsx` | use the shared field |
| `src/app/(admin)/providers/actions.ts` | parse and persist on create |
| `src/app/(admin)/providers/page.tsx` | render the datalist; zero-match warning |
