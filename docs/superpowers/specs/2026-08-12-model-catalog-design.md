# Model Catalog — design

**Phase 1.5.** Ships after Phase 1, before the Phase 2 routing engine.

## 1. Problem

`route_targets.upstream_model` is free text typed by hand. Nothing validates it,
so a typo surfaces as a 404 from the provider at request time, and there is no
way to see what models a configured provider actually serves. Phase 4 needs
per-model prices; Phase 3 needs model metadata. All three want the same thing: a
per-provider inventory of models, kept current by asking the providers.

The Model Catalog is that inventory. It is **advisory** — the gateway never reads
it on the request path, and no sync failure can affect routing.

## 2. Scope

In scope:

- `catalog_models` table, populated by provider auto-discovery and enriched from
  models.dev, a vendored snapshot, and admin overrides.
- Manual sync per provider and across all providers; sync on provider create and
  on credential update.
- A `/catalog` dashboard page with search, filters, per-field overrides and
  provenance.
- A searchable model picker in the route-target form that still accepts
  arbitrary text.
- Riders, all touching the same forms: provider **credential edit UI**,
  `updateRouteTarget`, unknown-model warnings on existing targets, and a
  catalog → route shortcut.

Out of scope: scheduled background sync; any change to the request path; the
`gemini` and `bedrock` chat adapters (Phase 3); cost computation (Phase 4).

## 3. Decisions

| Decision | Choice |
|---|---|
| Coupling to routing | `route_targets.upstream_model` stays text. No FK. Catalog is advisory. |
| Metadata sources | Four layers: admin override, provider discovery, models.dev registry, vendored seed. |
| Precedence | `override > discovered > registry > seed`, resolved **field by field**, first non-null wins. |
| Row keying | One row per (provider, model id), plus a nullable `canonical_key` for registry matching. |
| Pricing home | The catalog owns price. The spec's planned `model_prices` table is dropped. |
| Sync triggers | Manual button (per provider and all), plus provider create and credential update. No scheduler. |
| Missing models | Kept and marked `missing`. Never deleted by a sync. |
| Registry | models.dev, opt-in via settings, projected and cached in the database. |
| Seed | A committed models.dev snapshot with a refresh script, parsed by the same code as the registry. |

### Why the catalog owns price

The spec reserved `model_prices` with a nullable `provider_id`, where null meant
"default for this model name across providers". The seed layer now *is* that
default, so the null-provider row has no reason to exist. Price also genuinely
differs per provider — Claude via Bedrock and via Anthropic are different
numbers, Llama on Groq and on a local Ollama box differ by orders of magnitude —
so per-provider rows are the correct grain, not a compromise. Phase 4's cost
lookup becomes one indexed read by (provider, upstream model) with no join.

### Why flat rows rather than canonical models + offerings

A two-table model (global model identities + per-provider offerings) would store
metadata once and let one edit apply everywhere. That is the wrong property for
the field that matters most: price is per-provider. Sharing it would immediately
need per-offering overrides, which is the flat model with an extra join. Flat
rows also keep overrides at the grain an admin reasons about ("this proxy really
does cap at 64k").

The cost is that matching models.dev entries onto discovered ids needs
per-adapter string normalization, which will be imperfect. Unmatched rows are
therefore visible in the UI, so a gap is something to fix with an override
rather than a mystery.

## 4. Data model

**`catalog_models`** — unique on (`provider_id`, `model_id`); `provider_id`
cascades on provider delete.

```
id             uuid pk
provider_id    uuid -> providers (cascade)
model_id       text          -- as the provider reports it, or as typed
canonical_key  text null     -- derived models.dev key; null = unmatched
origin         enum(discovered | manual)
status         enum(available | missing)
first_seen_at  timestamptz
last_seen_at   timestamptz

-- layers, stored raw and never merged into one another
discovered  jsonb
registry    jsonb
seed        jsonb
override    jsonb   -- the only column a human writes

-- effective values, written by merge(), indexable
kind                   text        -- chat | embedding | image | audio | video | unknown
context_window         int null
max_output_tokens      int null
input_per_mtok         numeric null
output_per_mtok        numeric null
cached_input_per_mtok  numeric null
supports_tools         bool null
supports_streaming     bool null
modalities             jsonb null
sources                jsonb       -- {context_window: "registry", ...}

created_at  timestamptz
updated_at  timestamptz
```

`sources` maps each effective field to the layer that supplied it, so the UI can
render "$2.50 (models.dev)" beside "64,000 (overridden)". It is produced by the
same function that computes the merge.

**`providers`** gains `last_synced_at`, `last_sync_status`
(`ok | failed | unsupported`), `last_sync_error`, and `last_sync_summary` jsonb
(`{added, updated, missing, total}`).

**`registry_cache`** — `url` pk, `payload` jsonb (the *projected* lookup table,
not the raw document), `fetched_at`, `etag` nullable. Survives restarts, so a
fresh container with no egress still merges the last known good data.

**`settings`** — `key` text pk, `value` jsonb. The spec already plans this table
for Phase 4. The catalog needs two keys now — `catalog.registry_enabled` and
`catalog.registry_url` — and introducing the table properly beats smuggling them
into `registry_cache` or an environment variable.

`route_targets` is unchanged. New columns use real `jsonb`; the existing
`providers.config` text column is left as it is.

## 5. Components

```
src/lib/catalog/registry.ts    fetch models.dev, project, cache
src/lib/catalog/seed.ts        load the vendored snapshot through the same projection
src/lib/catalog/normalize.ts   canonical-key candidates per adapter
src/lib/catalog/merge.ts       pure merge, no I/O
src/lib/catalog/sync.ts        orchestration
src/lib/admin/catalog.ts       list/filter, overrides, manual add/delete
src/lib/catalog/seed/models.json   vendored snapshot
scripts/refresh-seed.mjs           re-dump the snapshot
```

`merge.ts` and `normalize.ts` are pure and carry most of the tests. `sync.ts` is
the only module needing a provider double.

### Adapter interface

`ProviderAdapter` gains one optional method:

```ts
listModels?(ctx: { signal: AbortSignal }): Promise<DiscoveredModel[]>
```

Optional, so `gemini` and `bedrock` simply lack it until Phase 3 and their syncs
report `unsupported` instead of throwing. The OpenAI adapter implements it with
`client.models.list()`, which covers `openai_compatible` too.

`DiscoveredModel` is deliberately thin — `{ id, raw }`, where `raw` is whatever
the provider returned for that entry and becomes the `discovered` blob after the
adapter maps any fields it does understand (Gemini's token limits, Bedrock's
modalities) onto the catalog's field names. Adapters that learn nothing beyond an
id, which is every OpenAI-shaped one, return an empty mapping.

### merge()

`(discovered, registry, seed, override) → {effective, sources}`. No database, no
network. First non-null wins in `override → discovered → registry → seed` order,
per field. Clearing an override records a key removal in the `override` blob and
re-merges, so "revert to inherited" is a real operation rather than a guess at a
previous value.

`kind` gets one extra step after all four layers miss: an id-prefix heuristic
(`text-embedding-*`, `whisper-*`, `dall-e-*`, `tts-*`), then `unknown`.

models.dev has no chat/embedding marker; `kind` is derived from output
modalities, then `family` matching `/embed/i`, then `cost.output === 0 &&
temperature === false`.

### normalize()

Returns *candidate* canonical keys, tried in order; the first that hits an entry
wins, and no hit leaves `canonical_key` null.

| Adapter | Candidates |
|---|---|
| `openai` | id as-is → dated snapshot suffix stripped (`gpt-4o-2024-08-06` → `gpt-4o`). `ft:` fine-tunes stay unmatched by design. |
| `gemini` | strip the `models/` prefix |
| `bedrock` | id as-is → region prefix (`us./eu./apac./global.`) stripped → each known region prefix added |
| `openai_compatible` | id as-is → `{config.registryNamespace}/{id}` → leading vendor segment stripped |

`config.registryNamespace` is a new optional provider config field, letting an
Ollama or Groq provider declare which models.dev namespace it maps into rather
than having the normalizer guess.

Canonical keys are namespaced by the models.dev provider slug —
`openai/gpt-4o`, `amazon-bedrock/us.deepseek.r1-v1:0`,
`google/gemini-flash-latest`. An `openai_compatible` provider with no
`registryNamespace` configured produces no candidates and stays unmatched,
which is correct: the namespace cannot be guessed. Note that `ollama` has no
models.dev namespace at all.

## 6. Sync

The network call happens outside the transaction; every write happens inside
one.

1. No `listModels` → record `unsupported` with a plain reason, touch no rows.
2. Call it under the discovery timeout. On failure, classify: `401/403` →
   credentials, `404/405` → "this endpoint has no listing API", otherwise the
   transport error. Record `failed` with the message. **Existing rows are left
   untouched** — a bad sync never degrades the catalog.
3. On success, upsert one row per returned model: write `discovered`, set
   `status = available`, bump `last_seen_at`, set `first_seen_at` when new.
4. Rows for this provider with `origin = discovered` that were not returned →
   `status = missing`. Manual rows are never marked missing, because nothing
   claims authority over them.
5. Resolve `canonical_key`; attach the matching `registry` and `seed` blobs.
6. `merge()` every touched row; write effective columns and `sources`.
7. Write the provider's bookkeeping: status, timestamp, and
   `{added, updated, missing, total}`.

If a hand-added model later appears in discovery, `origin` flips to `discovered`
— it is discovered now — and its `override` blob rides along untouched, because
overrides live in their own column and nothing else ever writes there.

models.dev is fetched once per sync *run*, not per provider, and only when the
cache is older than 24 hours; an explicit "Refresh registry" action forces it. A
failed fetch is non-fatal: the run continues on cache and seed and reports that
it did.

When `catalog.registry_enabled` is off, no fetch is attempted and the `registry`
layer is skipped entirely — merges run on `override → discovered → seed`. Any
`registry` blobs written by earlier syncs are left in place but ignored, so
re-enabling the setting restores the previous behaviour without a refetch.

## 7. Dashboard

Nav becomes `Providers · Catalog · Virtual models · API keys · Users`.

**`/catalog`** — server-rendered table over `catalog_models`. Search by model id;
filter by provider, kind and status. Columns: model, provider, kind, context,
in/out price, status. Missing models carry a warning badge, and a louder one when
a route target still points at them. A row opens a detail panel showing every
field with its source label (`models.dev`, `provider`, `seed`, `overridden`),
where any field can be overridden or cleared back to inherited. Page actions:
**Sync all**, **Refresh registry**, **Add model manually** (lands as
`origin = manual`). A settings panel at the foot of the page holds the registry
toggle and URL with the last fetch time and outcome — two fields do not justify
a settings page.

**Providers** gains a per-provider **Sync models** button with a status line
(`synced 2m ago · +3 new ~12 updated !1 missing`, or the failure reason), a model
count linking into the filtered catalog, and the **credential edit form** —
wiring the already-implemented, already-tested `updateProvider` to real UI. That
closes the handoff's most urgent gap: rotating a leaked key stops meaning
delete-every-target-and-recreate. Saving credentials triggers a sync for that
provider.

**Virtual models**:

- The upstream-model input becomes a searchable combobox over that provider's
  catalog rows, grouped chat-first with an `unknown` group last and a *show
  non-chat* toggle. It is a combobox, not a select: anything typed is saveable,
  and an unrecognised value shows an inline "not in catalog" warning without
  blocking the save.
- **`updateRouteTarget`** — targets become editable in place (upstream model,
  priority, weight) instead of remove-and-re-add. New server action, new admin
  function, plus the missing test coverage.
- Existing targets whose `upstream_model` is absent from the catalog, or present
  but `missing`, get a badge. This is what finds typos already saved.

**Catalog → route shortcut.** From a catalog row, *Route to this* picks an
existing virtual model or names a new one and creates the target prefilled. It
calls the same `addRouteTarget` admin function — a second entry point, not
parallel logic.

## 8. Failure modes

**Nothing a sync does can break routing.** Route targets are text, the gateway
never reads the catalog on the request path, and a failed sync leaves rows
untouched. Worst case, the picker is stale.

**Concurrent syncs.** Each provider sync takes a Postgres advisory lock keyed on
its id; a second attempt returns "sync already running" rather than queuing.

**Registry payload size.** models.dev's document is large and mostly irrelevant
here. It is parsed and projected down to the merged fields, keyed by canonical
key, *before* caching, so `registry_cache.payload` stays small and each sync
reads a ready-made lookup table. The seed loader uses the same projection.

**Timeouts.** Discovery gets its own budget (default 30s), separate from
`config.timeoutMs`, which is tuned for chat.

**Error classification.** `sync.ts` classifies its own failures and does not
touch `classifyProviderError`. The Phase 1 handoff asks for a decision on moving
classification behind the adapter boundary *before Phase 2*; this phase
deliberately does not pre-empt it.

**Secrets.** `listModels` runs server-side with decrypted credentials and returns
model ids. No catalog column can hold a credential; nothing new reaches the
browser.

**Deleting rows.** Any row can be deleted, but a discovered one returns on the
next sync with its override gone. The confirmation says so. Deleting a provider
cascades its catalog rows away.

**Disabled providers** can still be synced. Disabled means "do not route here",
not "forget what it serves".

**Unpriced models** keep null prices and render "—", matching the existing rule
that a missing price is never a silent zero.

**First deploy.** The catalog is empty and every existing route target would
otherwise show "not in catalog". The badge distinguishes *provider never synced*
from *model genuinely absent*, so an upgrade does not greet the admin with a wall
of false warnings.

## 9. Testing

No new test infrastructure: this fits the existing `tests/` layout, the
injected-`fetch` pattern from the OpenAI adapter tests, and the
truncate-per-file DB harness.

- **`merge.ts`** — precedence per field across all four layers; a cleared
  override falling through to the next layer rather than to null; `sources`
  naming the right layer; the `kind` heuristic firing only after all four miss.
- **`normalize.ts`** — table-driven per adapter: Bedrock region and version
  stripping, OpenAI dated snapshots, `ft:` staying unmatched, `registryNamespace`
  taking effect, candidate ordering.
- **`registry.ts`** — injected `fetch` with a trimmed models.dev fixture: cache
  hit, staleness triggering a refetch, fetch failure falling back to cache, and
  fetch failure with no cache degrading to seed-only without failing the run.
- **`seed.ts`** — the vendored snapshot and a live registry response come out of
  the same projection with the same shape. This is what catches a bad
  `refresh-seed.mjs` commit.
- **`sync.ts`**, DB-backed against a fake adapter — new models inserted, absent
  ones marked missing, manual rows never marked missing, **overrides surviving a
  re-sync**, the `unsupported` path, a thrown error leaving every existing row
  byte-identical, summary counts, and the advisory lock rejecting a concurrent
  run.
- **`admin/catalog.ts`** — filters, override write and clear, manual add and
  delete.
- **OpenAI `listModels`** against a `models.list` fixture.
- **`updateRouteTarget`** and the credential-edit path through `updateProvider`.

The override-survives-re-sync test is load-bearing: it guards the one failure
that would quietly destroy hand-entered data.

## 10. Effect on the phase plan

```
Phase 1    done
Phase 1.5  Model Catalog (+ credential edit UI, updateRouteTarget)
Phase 2    Routing engine
Phase 3    Gemini / Bedrock adapters, /v1/models, /v1/embeddings
Phase 4    Governance — cost computation reads the catalog
```

`/v1/models` in Phase 3 remains what the spec says it is: the client-facing list
of **virtual** models. The catalog is upstream inventory and is not exposed to
gateway clients.

Phase 4's `model_prices` table is dropped from the plan; its price fields live on
`catalog_models`, and its provider-agnostic default row is replaced by the seed
layer.
