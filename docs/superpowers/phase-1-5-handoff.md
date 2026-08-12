# Phase 1.5 handoff — Model Catalog

**Completed:** 2026-08-12 · 25 commits · 267 tests · `tsc`, `lint`, `build` all clean

Phase 1.5 delivers the Model Catalog: a per-provider inventory of models,
discovered by asking providers directly and enriched from three further
metadata layers (models.dev at runtime, a vendored snapshot offline, and admin
overrides), merged field by field. It also closes the Phase 1 handoff's most
urgent gap — provider credentials are now editable in the dashboard — and adds
`updateRouteTarget`, which Phase 2 needs.

This document carries forward what twelve task reviews, six fix rounds and the
final whole-branch review surfaced but deliberately did not fix. It exists for
the same reason `phase-1-handoff.md` does: those findings lived in a
git-ignored working directory that has since been deleted.

## Decide before writing Phase 2 code

**Nothing blocks Phase 2.** The catalog is advisory by construction — the
gateway request path never reads catalog tables, `route_targets.upstream_model`
is still bare text with no foreign key, and no sync failure can affect routing.
All three were re-confirmed by inspection in the final review.

The Phase 1 handoff's open question about **where provider error classification
lives** is still open and still worth deciding first. Phase 1.5 deliberately
did not pre-empt it: `sync.ts` classifies its own discovery failures locally
(`describeDiscoveryError`) and never touches `classifyProviderError`.

## Carried forward, in rough priority order

### Concurrency and consistency

- **Override edits are a three-statement read-modify-write** with no
  transaction and no row lock (`src/lib/admin/catalog.ts`, `setOverride` /
  `clearOverrideField`: SELECT → UPDATE override → re-merge UPDATE). Three
  failure shapes, all recoverable by re-saving or re-syncing, all with the same
  symptom — the override input shows the typed value while the effective column
  and its "now from …" label disagree:
  1. A crash between the two UPDATEs leaves the blob written and the derived
     columns stale.
  2. A concurrent sync reads `existing` outside its transaction. The window is
     **milliseconds** (`sync.ts` reads after `listModels` and `loadRegistry`,
     not before) — an earlier note claiming a 30s window was wrong.
  3. **Two concurrent override edits lose one outright** — both read the same
     blob, each writes the whole thing back. This is the only one that destroys
     hand-entered data rather than causing temporary inconsistency, and it was
     not caught until the final review.

  One fix covers all three: wrap select/update/re-merge in a single
  transaction with `.for('update')` on the select, or write the patch with a
  SQL-side jsonb `||` merge.

- **`remerge()` does not consult `registryEnabled`.** When the registry is
  disabled or unreachable, a sync now preserves the stored `registry` blob but
  skips that layer (spec §6). `remerge` merges the blob regardless, so editing
  an override on such a row re-applies stale registry values and labels their
  source `registry`. Self-corrects on the next successful sync. Introduced by
  the final review's own fix for the opposite bug.

- **`providers.config` is also a read-modify-write** (`updateProviderAction`
  reads it, `updateProvider` writes it, with its own row read in between), so
  two admins saving concurrently can lose one namespace edit. Same family, same
  fix shape.

### Scale

- **`/catalog` has no pagination or row cap.** Every row renders two client
  components, each with its own `useActionState`. An OpenRouter-style
  `openai_compatible` provider lists 300–500 models; the vendored seed proves
  6280 exist across all namespaces. The spec asked only for search and filters,
  both present — this is a scale gap, not a missed requirement.
- **The picker payload is serialized once per virtual model.**
  `models/page.tsx` builds `groupsByProvider` across all providers and passes
  the whole map into every `AddTargetForm`. The RSC payload scales as
  |virtual models| × Σ|provider catalogs|. Pass only the selected provider's
  groups, or fetch on open.
- **`listCatalog` counts route targets O(n·m) in JS**, and
  `getCatalogSettings` reads every `settings` row rather than the two
  `catalog.*` keys. Both fine today; both wrong shapes once Phase 4 adds rows.

### Display and accessibility

- **`.toFixed(2)` can render a real price as `$0.00`.** models.dev carries
  several models under $0.01/Mtok. The stored `numeric(12,6)` is correct and
  Phase 4's cost computation reads the column, not the page — but the display
  sits one column away from this branch's own rule that a missing price renders
  `—` and is "never a silent zero".
- **Display formatters are duplicated** between `catalog/page.tsx` and
  `model-combobox.tsx`, and already render differently.
- **`createProviderAction` returns a `warning` the create form never renders.**
  A provider created with a bad key shows plain "Provider created."; the failure
  is visible only in the row's sync status after the revalidate.

### Bedrock (revisit with the Phase 3 adapter)

Both are invisible failures, and both are unreachable until bedrock has an
adapter:

- Ticking `useInstanceRole` while also typing an `accessKeyId` silently
  discards the typed key and reports success.
- Unticking `useInstanceRole` alone is a no-op.

Also still open from Phase 1: a bedrock credential rejection surfaces as the
bare string `Invalid input`, because `validate()` maps only top-level zod
issues and the bedrock schema is a union. That is unactionable during a
credential rotation.

### Test coverage gaps worth closing

- No test covers `override` winning specifically for the `kind` field — the one
  precedence cell with no coverage.
- The adapter-change test in `providers.test.ts` **passes either way** and does
  not actually pin `adapterChanged`. A test that does not pin its subject reads
  as coverage without being it; same-shape switches (`openai` →
  `openai_compatible`) are unpinned.
- `inferKindFromId` anchors the collision-prone tokens (`tts`, `sora`, `veo`,
  `sdxl`) but not the longer ones (`embed`, `imagen`, `flux`). No failing case
  was found by hand-tracing; consistency only.

## Never verified

- **Live client-side interaction with the model picker.** No browser was
  available to any agent during implementation, and the popup is portal-rendered
  so it only mounts on open — server rendering cannot reach it. What *was*
  verified, over real HTTP against a running server: the combobox emits
  `name="upstreamModel"` carrying the current value for both a catalog-known
  model and a hand-typed unknown one, so free text does reach `FormData`.

  **Click this first:** on `/models`, expand *Edit* on a target → click the
  upstream-model field → confirm the popup opens with chat first and unknown
  last → type a partial id and confirm filtering works *within* groups → arrow
  down, Enter → confirm the input holds the selected id, the form did **not**
  submit on the click, and the amber warning cleared → Save and confirm it
  round-trips. Then repeat on *Add target*, **switching the provider select
  first** — that is the only path where the picker's props change after mount.

- **No sync has run against a real provider's `/v1/models`.** Every sync test
  uses a fake adapter. The OpenAI adapter relies on SDK auto-pagination with a
  single 30s signal covering all pages; against a proxy returning hundreds of
  models the per-model upsert loop also becomes N sequential round trips inside
  one transaction. Worth watching on the first real `openai_compatible` sync.

- **No component tests anywhere in the new UI.** This was a deliberate scope
  decision — the repo has no component-test infrastructure and introducing it
  was not part of this phase. It is why the accessibility and error-surface
  defects in this branch were caught by reading rather than by CI, and why the
  picker needs a human to click it.

## Deliberately not doing

- **Raw `<select>` instead of the shadcn `Select` component** throughout the
  catalog page. The pre-existing `/models` page does the same; changing one of
  five would be worse than consistency.
- **Already-missing rows get `updatedAt` bumped on every sync.** Cosmetic churn
  on a column nothing reads.
- **The lock-refused path skips `recordOutcome`**, unlike every other failure
  path. That is correct — a refused sync must not overwrite the last real
  outcome while a legitimate sync is in flight — but it is an undocumented
  asymmetry worth a comment.
- **`cachedIndex()`'s non-null assertion** in `registry.ts`. Both call sites are
  inside `if (cached)`; the assertion is true, just not type-level.
