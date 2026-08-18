# Per-model API flavor and request paths

Date: 2026-08-18
Status: approved, not yet implemented

## Problem

A provider declares one API flavor for everything it serves. That is wrong for
real providers: an endpoint can speak Chat Completions for most of its models
and expose one or two — the reasoning-heavy ones — only through the Responses
API. Today an operator who needs that has to register the same upstream twice
under two provider rows, which duplicates credentials, splits the catalog, and
makes each model reachable under two different names.

The same holds for the path a model is served on. `chatCompletionsPath` and
`responsesPath` are provider-wide config keys, so a clone that hangs one model
off a different route cannot be described at all.

## Decision

The **model** owns its flavor and its request paths. A provider's setting
becomes the default that a model inherits when it says nothing.

`route_targets.api_flavor` is removed. It was added on this branch (migration
`0008_true_tomas`) in the belief that a route target was the right place for
this fact; it is not. A target is a routing decision — which upstream to try,
in what order, with what weight — while the flavor is a property of the model
being addressed, true no matter which route reaches it. Keeping both would give
two answers to one question and force every screen to explain the precedence.

## 1. Schema

Delete migration `0008_true_tomas`: its `.sql`, its snapshot
`drizzle/meta/0008_snapshot.json`, and its entry in `drizzle/meta/_journal.json`.
The column never reached `main`, so there is nothing to revert and no
compatibility window to keep. Any flavor pinned on a target in a development
database is discarded; it is re-set on the model instead.

The new `0008` adds three nullable columns to `catalog_models`:

```sql
ALTER TABLE "catalog_models" ADD COLUMN "api_flavor" "api_flavor";
ALTER TABLE "catalog_models" ADD COLUMN "chat_completions_path" text;
ALTER TABLE "catalog_models" ADD COLUMN "responses_path" text;
```

All three are nullable with no default, because `NULL` is a distinct behaviour
rather than a missing value: it means "inherit the provider". A default would
make a model deliberately pinned to `chat_completions` indistinguishable from
one that was never configured — the same reasoning already written on
`route_targets.service_tier`.

These are columns, not `CatalogFields` in the layer merge, for the reason
already recorded on `providers.api_flavor`: they decide whether a request can be
served at all, which is a different class of fact from context window or price.
Concretely that means:

- `sync()` never writes them, so a re-sync cannot undo an operator's decision.
- `merge()` never reads them, so `sources` gains no entries and the
  discovered/registry/seed layers have no say.
- A row whose provider stopped listing it (`status = 'missing'`) keeps its
  gateway settings, and gets them back intact when the model returns.

Registry and seed snapshots may not declare a flavor. If a data source ever
supplies one, adding it is a separate change to the layer system.

## 2. Resolution

One rule, applied identically to both ways a request names a model:

```
effective flavor = catalog_models.api_flavor ?? providers.api_flavor
```

Both branches of `src/lib/gateway/resolve.ts` implement it:

- **`resolveDirect`** (`provider/model`) already selects the `catalog_models`
  row it validates the address against, so the flavor and paths come out of a
  query that is already being run. The comment stating that nothing could have
  overridden the provider's flavor for a direct address is deleted with the
  behaviour it described.
- **`findVirtualModel`** gains a `LEFT JOIN catalog_models ON (provider_id,
  model_id) = (route_targets.provider_id, route_targets.upstream_model)`.

The join is left, not inner, because `upstream_model` is free text: a target may
name a model that was never catalogued, and such a target must keep routing on
the provider's default rather than disappearing from the chain. A provider whose
adapter has no catalog-driven paths at all — Gemini, Bedrock — reaches the same
outcome by the same route.

`Candidate` keeps `apiFlavor: ApiFlavor` with its current meaning ("the flavor
this attempt uses, already resolved"), so `protocols/chat.ts` and
`protocols/responses.ts` need no change to their dropped-parameter reporting.
It gains one field:

```ts
/** Per-model path overrides, or null to use the provider's. Only
 *  OpenAI-shaped adapters read these. */
pathOverrides: ModelPathOverrides | null
```

## 3. Path plumbing

`createOpenAIAdapter` and `createResponsesAdapter` each call
`resolveProviderPaths(runtime.config)` once at construction. `execute.ts`
constructs an adapter per attempt, and an attempt is always for one model, so
the overrides can be applied at construction without any adapter learning that
models can carry paths:

```ts
// src/lib/adapters/registry.ts
export interface ModelPathOverrides {
  chatCompletionsPath?: string | null
  responsesPath?: string | null
}

export function createAdapter(
  provider: ProviderRow,
  flavor: ApiFlavor = provider.apiFlavor,
  paths?: ModelPathOverrides | null,
): ProviderAdapter
```

`createAdapter` folds the non-null entries over `runtime.config` before
dispatching on adapter type. The override keys are already exactly the config
keys `resolveProviderPaths` reads, so precedence collapses to a spread and
`paths.ts` is untouched except for the model-facing field list below. A `null`
or absent override leaves the provider's config exactly as it is.

`execute.ts` passes `candidate.pathOverrides` as the third argument. Catalog
sync keeps calling `createAdapter(provider)` with no model in hand, which is
correct: `modelsPath` stays provider-only, because listing models is a provider
operation.

Per-model paths are validated by the existing `parseProviderPath`, so the two
shapes that fail silently are rejected here too — an absolute URL, which would
be appended to the base URL rather than replacing it, and a query string, which
the SDK owns separately. `paths.ts` exports the model-facing subset of
`PATH_FIELDS` (`chatCompletionsPath`, `responsesPath`) so the catalog dialog
renders from the same description the provider form does.

## 4. Admin UI

**Removed.** `edit-target-form.tsx` and `model-form.tsx` lose their flavor
selector and the `providerApiFlavor` prop that fed it. `lib/admin/models.ts`
loses `apiFlavor` from `RouteTargetInput`, `validateTargetFields`,
`addRouteTarget`, `updateRouteTarget`, and `VirtualModelListItem['targets']`.
The target table on the virtual-model detail page loses its raw flavor badge.

**Moved.** `models/api-flavor-select.tsx` moves to
`components/admin/api-flavor-select.tsx`. Both its callers are being deleted and
its new caller is the catalog; its docstring changes from "the flavor selector
both target dialogs render" to describe inheriting from the provider.

**Added — catalog.** The row's ⋮ menu gains `Gateway settings…` beside the
existing `Edit overrides…`, opening a dialog with the flavor select
(`(inherit — Chat Completions)` / `Chat Completions` / `Responses`) and the two
path inputs, each placeheld with the provider's effective value so a blank box
reads as "inherit" rather than "no endpoint". A separate dialog rather than a
section inside the override dialog, because the two save through different
mechanisms: an override goes through the layer merge and has per-field "clear"
buttons, while these are a plain column update.

`lib/admin/catalog.ts` gains `setModelGateway(id, { apiFlavor, chatCompletionsPath,
responsesPath })` — a single `UPDATE`, no re-merge, no touch to `override`. It
validates the flavor against `API_FLAVORS` and each path through
`parseProviderPath`, throwing so the action reports a form error rather than
saving a model that cannot be reached. Blank clears back to `NULL`.
`CatalogListItem` carries the three values so the dialog can render its current
state.

**Added — virtual model detail.** With the target selector gone, the flavor
would otherwise be invisible on the screen where routing is configured. The
target table shows it read-only, derived by a new `targetGatewayViews()` in
`lib/admin/catalog.ts` — a sibling of `targetWarnings()`, built from the same
three queries it already runs — returning `{ flavor, source: 'model' | 'provider' }`
per target id and rendering as `Responses · from model`.

**Corrected.** `FLAVOR_HINT` in `adapters/openai/index.ts` tells operators to
set the route target's API flavor when an endpoint answers only the Responses
API. It is rewritten to point at the model's setting, then the provider's.
`README.md:57` says hosted tools need "a target whose API flavor" is Responses;
it becomes a model whose flavor is Responses.

## 5. Testing

Test-driven throughout, and in two passes: the deletions land first so the suite
is green with the target column gone, then each new behaviour is written as a
failing test before the code that satisfies it.

Deletions — the target-flavor cases in `tests/lib/gateway/resolve.test.ts`,
`tests/lib/admin/models.test.ts`, `tests/lib/gateway/execute.test.ts`, and
`tests/lib/db/schema.test.ts`.

**Helper change.** `apiFlavor` on `SeedOptions` and `TargetSpec` in
`tests/helpers/gateway.ts` keeps its name and its call signature, but changes
where it writes: instead of setting `route_targets.api_flavor`, it inserts a
`catalog_models` row for that target's `(provider, upstream_model)` carrying the
flavor. Every existing call site — `dropped-params`, `mixed-flavor`,
`responses-ingress`, `openai-client` — then goes on asserting the same
behaviour through the new mechanism, unchanged. The row is inserted only when
the option is given, so a test that says nothing about flavor still runs against
an uncatalogued target and pins the provider-default fallback. `TargetSpec`
gains `chatCompletionsPath` / `responsesPath` on the same row for the path
tests.

New coverage:

| Area | What it pins |
|---|---|
| `resolve.test.ts` | Model flavor beats the provider's for a direct address and for a route target; a target whose upstream model has no catalog row falls back to the provider; a catalogued model on a disabled provider still answers 503. |
| `tests/gateway/mixed-flavor.test.ts` | Unchanged at the call sites, but now proving the two flavors in one failover chain come from two models. One added case: two targets on the *same* provider whose models differ in flavor — the arrangement that was impossible before. |
| `tests/lib/adapters/registry.test.ts` | A per-model path reaches the OpenAI client; a null override leaves the provider's path intact; the models path is never overridden; Gemini ignores overrides entirely. |
| `paths` validation | An absolute URL and a query string are rejected per model, with the same messages the provider form gives. |
| `tests/lib/admin/catalog.test.ts` | `setModelGateway` writes all three, clears each back to NULL on blank, rejects a bad flavor and a bad path, and leaves `override` and every merged column untouched. `targetGatewayViews` reports the source correctly for catalogued, uncatalogued, and provider-default targets. |
| `schema.test.ts` | The three new columns exist and default to NULL; `route_targets` has no `api_flavor`. |

Tests run against the disposable Postgres on 5434 per `AGENTS.md`.

## Out of scope

- Per-model `modelsPath` — listing is a provider operation.
- Per-model service tier, breaker threshold, or cooldown.
- Registry or seed snapshots declaring a model's flavor.
- Any change to how the gateway translates between the two protocols.
