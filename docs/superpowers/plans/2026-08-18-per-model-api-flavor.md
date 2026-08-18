# Per-Model API Flavor and Request Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the API flavor from the route target to the catalog model, and let a model override the chat/responses paths the gateway calls it on.

**Architecture:** `catalog_models` gains three nullable columns (`api_flavor`, `chat_completions_path`, `responses_path`), where `NULL` means "inherit the provider". `resolve.ts` reads them for both address forms — directly for `provider/model`, and through a left join on `(provider_id, upstream_model)` for a virtual model's route targets — and puts the result on `Candidate`. Path overrides ride into `createAdapter` as a third argument and are folded over the provider's config, so no adapter learns that models can carry paths. `route_targets.api_flavor` and its migration are deleted; they never reached `main`.

**Tech Stack:** TypeScript, Next.js 16.3 (App Router, server actions), drizzle-orm 0.45 + drizzle-kit, PostgreSQL 17, vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-18-per-model-api-flavor-design.md`

## Global Constraints

- **Never run tests against port 5432.** That is the developer's own database. Tests read `.env.test`, whose `DATABASE_URL` is `postgres://babellm:babellm@localhost:5434/babellm_test`. Start it with `pnpm test:db:up` before the first task and leave it running.
- **Never run `pnpm test:db:down`.** It is shared across checkouts. When you need a clean database, drop and recreate it (Task 1 does this once, deliberately).
- Work happens directly on the current branch, `worktree-responses-api`. No worktree, no new branch.
- Verification for every task: `pnpm test`, `pnpm typecheck`, `pnpm lint` — all three must pass before the commit step.
- `NULL` on every column this plan adds means "inherit the provider". Never give one a default; a default would make a deliberate `chat_completions` indistinguishable from an unconfigured model.
- Commit messages follow the repo's style: a conventional-commit subject, a body explaining *why*, and these two trailers:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
  ```
- Comments explain *why*, not *what* — match the density and voice of the surrounding code.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `drizzle/0008_*.sql` + `drizzle/meta/` | The one migration adding the catalog columns. The old `0008_true_tomas` (route-target flavor) is deleted, freeing the slot. |
| `src/lib/db/schema.ts` | `catalogModels.apiFlavor` / `.chatCompletionsPath` / `.responsesPath`; no `routeTargets.apiFlavor`. |
| `src/lib/adapters/types.ts` | `ModelPathOverrides` — the shape a model contributes to adapter construction. |
| `src/lib/adapters/registry.ts` | `createAdapter(provider, flavor, paths?)` and the fold of model paths over provider config. |
| `src/lib/adapters/openai/paths.ts` | Unchanged resolution; adds `MODEL_PATH_FIELDS`, the two fields a model may set. |
| `src/lib/gateway/resolve.ts` | The single precedence rule: `catalog.apiFlavor ?? provider.apiFlavor`, applied to both address forms. |
| `src/lib/gateway/execute.ts`, `handler.ts` | Pass `candidate.pathOverrides` through to `createAdapter`. |
| `src/lib/admin/catalog.ts` | `setModelGateway()` (a plain column write, no layer merge) and `targetGatewayViews()` (effective flavor per target, for display). |
| `src/lib/admin/models.ts`, `src/app/(admin)/models/*` | Route targets, with no flavor of their own. |
| `src/components/admin/api-flavor-select.tsx` | The flavor selector, now shared by the catalog dialog (moved out of `models/`). |
| `src/app/(admin)/catalog/*` | The Gateway settings dialog, its menu entry, and its server action. |
| `tests/helpers/gateway.ts` | `apiFlavor` / path options on seed helpers write a `catalog_models` row. |

---

## Task 1: Remove the route-target API flavor

The route target was the wrong home for this setting. Everything that reads or
writes `route_targets.api_flavor` goes, the migration that added it is deleted
rather than reverted (it never reached `main`), and the flavor becomes a
provider-only fact again — which the next tasks build on.

**Files:**
- Delete: `drizzle/0008_true_tomas.sql`, `drizzle/meta/0008_snapshot.json`
- Modify: `drizzle/meta/_journal.json` (drop the `idx: 8` entry)
- Modify: `src/lib/db/schema.ts` (`routeTargets`)
- Modify: `src/lib/gateway/resolve.ts:110`
- Modify: `src/lib/admin/models.ts`
- Modify: `src/app/(admin)/models/actions.ts`
- Modify: `src/app/(admin)/models/edit-target-form.tsx`
- Modify: `src/app/(admin)/models/model-form.tsx`
- Modify: `src/app/(admin)/models/target-row-actions.tsx`
- Modify: `src/app/(admin)/models/[id]/page.tsx`
- Modify: `tests/helpers/gateway.ts`
- Modify: `tests/lib/gateway/resolve.test.ts`, `tests/lib/admin/models.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RouteTargetInput` and `VirtualModelListItem['targets'][number]` with no `apiFlavor`. `SeedOptions.apiFlavor` / `TargetSpec.apiFlavor` in `tests/helpers/gateway.ts` keep their names and types (`ApiFlavor | null`) but now set the seeded **provider's** flavor. Task 3 changes where they write again; the call sites never change.

- [ ] **Step 1: Delete the migration and free the `0008` slot**

```bash
rm drizzle/0008_true_tomas.sql drizzle/meta/0008_snapshot.json
```

Then edit `drizzle/meta/_journal.json` and remove the last entry, including the
comma that precedes it, so the array ends at `idx: 7`:

```json
    {
      "idx": 7,
      "version": "7",
      "when": 1786890426222,
      "tag": "0007_worthless_randall_flagg",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 2: Drop the test database so the deleted migration is not "already applied"**

drizzle records applied migrations in the database. A test database that
already ran the old `0008` would skip the *new* `0008` added in Task 2 and fail
with `column "api_flavor" does not exist` on a table that looks fine in the
schema file. `tests/setup/global-setup.ts` recreates and re-migrates it on the
next run.

```bash
psql postgres://babellm:babellm@localhost:5434/postgres \
  -c 'DROP DATABASE IF EXISTS babellm_test WITH (FORCE)'
```

- [ ] **Step 3: Remove the column from the schema**

In `src/lib/db/schema.ts`, delete this field and its comment from `routeTargets`:

```ts
  // Nullable with no default, because NULL is a distinct behaviour rather than
  // a missing value: it means "inherit the provider's flavor". A default would
  // make a target that was deliberately set to chat_completions
  // indistinguishable from one that was never configured.
  apiFlavor: apiFlavorEnum('api_flavor'),
```

`apiFlavorEnum` stays — `providers.apiFlavor` still uses it.

- [ ] **Step 4: Point the resolver at the provider**

In `src/lib/gateway/resolve.ts`, inside `findVirtualModel`'s `rows.map`:

```ts
      apiFlavor: provider.apiFlavor,
```

and update the `Candidate.apiFlavor` docstring, which currently explains a
target-level NULL:

```ts
  /** The protocol this target's endpoint speaks. Resolved rather than
   *  nullable: the routing loop must never have to work out where the
   *  answer came from. */
  apiFlavor: ApiFlavor
```

- [ ] **Step 5: Remove it from the admin layer**

In `src/lib/admin/models.ts`, delete `apiFlavor` from: `RouteTargetInput`,
`VirtualModelListItem['targets']`, the object built in `toListItem`, both
inline parameter types of `validateTargetFields` and `updateRouteTarget`, the
`addRouteTarget` insert values, and this validation block:

```ts
  // `null` means "inherit the provider's flavor" — a real, distinct setting,
  // not an omission. Only `undefined` leaves this field alone.
  if (input.apiFlavor !== undefined) {
    if (input.apiFlavor !== null && !API_FLAVORS.includes(input.apiFlavor)) {
      throw new Error(`"${input.apiFlavor}" is not a supported API flavor.`)
    }
    patch.apiFlavor = input.apiFlavor
  }
```

Then drop the now-unused `API_FLAVORS` / `ApiFlavor` import.

- [ ] **Step 6: Remove it from the server actions**

In `src/app/(admin)/models/actions.ts`, delete the `apiFlavorValue` helper with
its docstring, both `apiFlavor: apiFlavorValue(formData.get('apiFlavor')),`
lines, and the `ApiFlavor` import. (Task 6 reintroduces the same helper in the
catalog actions, where the field now lives.)

- [ ] **Step 7: Remove the selector from the target dialogs**

In `src/app/(admin)/models/edit-target-form.tsx`: delete the `ApiFlavorSelect`
import, the `ApiFlavor` type import, the `providerApiFlavor` prop (both the
destructured name and its type), `apiFlavor: ApiFlavor | null` from the
`target` prop type, and this block:

```tsx
      <div className="space-y-2">
        <Label htmlFor={`edit-flavor-${target.id}`}>API flavor</Label>
        <ApiFlavorSelect
          id={`edit-flavor-${target.id}`}
          defaultValue={target.apiFlavor}
          providerDefault={providerApiFlavor}
        />
        <p className="text-xs text-muted-foreground">
          Which endpoint this target is called on. Only meaningful for OpenAI-shaped providers.
        </p>
      </div>
```

In `src/app/(admin)/models/model-form.tsx`: delete the same imports, the
equivalent block, **and** the now-unused `selectedProvider` line —

```tsx
  const selectedProvider = providers.find((provider) => provider.id === providerId)
```

— narrowing the prop type to `providers: Array<{ id: string; name: string }>`.

In `src/app/(admin)/models/target-row-actions.tsx`: delete the `ApiFlavor`
import, the `providerApiFlavor` prop and its type, `apiFlavor: ApiFlavor | null`
from the `target` type, and the `providerApiFlavor={providerApiFlavor}`
passthrough on line 113.

- [ ] **Step 8: Keep the detail page's flavor column, sourced from the provider**

In `src/app/(admin)/models/[id]/page.tsx`, delete the two `providerApiFlavor={…}`
props passed to `TargetRowActions`, and replace the flavor cell — which read a
target column that no longer exists — with the provider's value. `providers` is
already in scope. (Task 6 replaces this expression again, with the *effective*
flavor.)

```tsx
                  <TableCell>
                    <Badge variant="outline">
                      {providers.find((provider) => provider.id === target.providerId)
                        ?.apiFlavor ?? 'chat_completions'}
                    </Badge>
                  </TableCell>
```

- [ ] **Step 9: Point the seed helpers at the provider**

In `tests/helpers/gateway.ts`, `SeedOptions.apiFlavor` and `TargetSpec.apiFlavor`
keep their declarations. Change where they are written.

In `seedGateway`, move the value onto the provider insert and drop it from the
target insert:

```ts
  const [provider] = await db.insert(providers).values({
    name: 'test-provider',
    adapter: options.adapter ?? 'openai',
    credentials: encryptJson(options.credentials ?? { apiKey: 'sk-upstream' }),
    ...(options.apiFlavor ? { apiFlavor: options.apiFlavor } : {}),
  }).returning()

  const [target] = await db.insert(routeTargets).values({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel,
    serviceTier: options.serviceTier ?? null,
  }).returning()
```

In `seedTargets`, the same move — each `TargetSpec` already creates its own
provider, so a per-target flavor and a per-provider flavor are the same thing
at every existing call site:

```ts
    const [provider] = await db.insert(providers).values({
      name: spec.name,
      adapter: spec.adapter ?? 'openai',
      credentials: encryptJson({ apiKey: `sk-${spec.name}` }),
      ...(spec.apiFlavor ? { apiFlavor: spec.apiFlavor } : {}),
    }).returning()

    const [target] = await db.insert(routeTargets).values({
      virtualModelId: model.id,
      providerId: provider.id,
      upstreamModel: `${spec.name}-model`,
      priority: spec.priority ?? 0,
      weight: spec.weight ?? 100,
      serviceTier: spec.serviceTier ?? null,
      enabled: spec.enabled ?? true,
    }).returning()
```

- [ ] **Step 10: Delete the tests that pinned the removed behaviour**

From `tests/lib/gateway/resolve.test.ts`, delete `'a target flavor overrides the
provider'` entirely, and rename `'a target with no flavor inherits the
provider'` to `'a target inherits its provider flavor'` (its body already only
touches the provider column and stays valid).

From `tests/lib/admin/models.test.ts`, delete `'rejects an unknown api flavor'`
and `'stores a null flavor as inherit'`, plus the `ApiFlavor` import if it is
left unused.

- [ ] **Step 11: Run the full suite**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: PASS. `mixed-flavor`, `responses-ingress`, `dropped-params` and
`contract/openai-client` are untouched — they set flavors through the helper,
which now writes a provider column.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(models): take the API flavor off the route target

A route target is a routing decision — which upstream to try, in what order,
with what weight. Which protocol an endpoint speaks is a property of the model
being addressed, true no matter which route reaches it, and the following
commits move it there.

The migration that added the column is deleted rather than reverted: it only
ever existed on this branch, so there is no deployed database to migrate and
no compatibility window to keep.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 2: Add the catalog columns

**Files:**
- Modify: `src/lib/db/schema.ts` (`catalogModels`)
- Create: `drizzle/0008_<generated>.sql` and `drizzle/meta/0008_snapshot.json` (via drizzle-kit)
- Test: `tests/lib/db/schema.test.ts`

**Interfaces:**
- Consumes: Task 1's freed `0008` migration slot.
- Produces: `CatalogModelRow` gains `apiFlavor: ApiFlavor | null`, `chatCompletionsPath: string | null`, `responsesPath: string | null`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/db/schema.test.ts`, after the two provider-flavor tests.
Add `catalogModels` to the import from `@/lib/db/schema` if it is not there.

```ts
test('a catalog model inherits its provider flavor and paths by default', async () => {
  const [p] = await db.insert(providers).values({
    name: 'catalog-defaults', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()

  const [row] = await db.insert(catalogModels).values({
    providerId: p.id, modelId: 'gpt-5',
  }).returning()

  // NULL, not 'chat_completions': a model that was never configured must stay
  // distinguishable from one deliberately pinned to the provider's default.
  expect(row.apiFlavor).toBeNull()
  expect(row.chatCompletionsPath).toBeNull()
  expect(row.responsesPath).toBeNull()
})

test('a catalog model can pin its own flavor and paths', async () => {
  const [p] = await db.insert(providers).values({
    name: 'catalog-pinned', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()

  const [row] = await db.insert(catalogModels).values({
    providerId: p.id,
    modelId: 'o5-pro',
    apiFlavor: 'responses',
    chatCompletionsPath: '/api/chat',
    responsesPath: '/api/responses',
  }).returning()

  expect(row.apiFlavor).toBe('responses')
  expect(row.chatCompletionsPath).toBe('/api/chat')
  expect(row.responsesPath).toBe('/api/responses')
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test tests/lib/db/schema.test.ts
```

Expected: FAIL — TypeScript rejects `apiFlavor` on the insert, and the columns
do not exist.

- [ ] **Step 3: Add the columns to the schema**

In `src/lib/db/schema.ts`, inside `catalogModels`, after the `sources` field and
before `createdAt`:

```ts
    // How the gateway reaches this model, as opposed to what the model is.
    // Columns rather than layers, for the reason on providers.apiFlavor: these
    // decide whether a request can be served at all. sync() and merge() never
    // touch them, so a re-sync cannot undo an operator's decision and a model
    // that goes missing keeps its settings for when it comes back.
    // NULL means "inherit the provider" in all three.
    apiFlavor: apiFlavorEnum('api_flavor'),
    chatCompletionsPath: text('chat_completions_path'),
    responsesPath: text('responses_path'),
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

Expected: a new `drizzle/0008_*.sql` containing three `ALTER TABLE
"catalog_models" ADD COLUMN` statements and nothing else, plus
`drizzle/meta/0008_snapshot.json` and an `idx: 8` journal entry. Read the `.sql`
and confirm it does not try to drop anything — if it does, the Task 1 journal
edit was wrong.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/db/schema.test.ts
```

Expected: PASS. `global-setup` recreates `babellm_test` and applies every
migration from scratch.

- [ ] **Step 6: Verify the whole suite, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A
git commit -m "$(cat <<'EOF'
feat(catalog): give a model its own flavor and endpoint paths

Three nullable columns, written only by an operator. They sit beside the layer
system rather than inside it because they decide whether a request can be
served at all, which is not the same class of fact as a context window or a
price — and because a re-sync must never overwrite them.

Nothing reads them yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 3: Resolve the flavor from the model

**Files:**
- Modify: `src/lib/gateway/resolve.ts`
- Modify: `tests/helpers/gateway.ts`
- Test: `tests/lib/gateway/resolve.test.ts`, `tests/gateway/mixed-flavor.test.ts`

**Interfaces:**
- Consumes: `catalogModels.apiFlavor` from Task 2.
- Produces: `Candidate.apiFlavor` resolved as `catalog.apiFlavor ?? provider.apiFlavor` for both address forms. `SeedOptions.apiFlavor` / `TargetSpec.apiFlavor` now write a `catalog_models` row for the target's `(provider, upstreamModel)`.

- [ ] **Step 1: Switch the seed helpers to catalog rows**

In `tests/helpers/gateway.ts`, add `catalogModels` to the `@/lib/db/schema`
import and revert the provider inserts Task 1 changed, writing a catalog row
instead.

In `seedGateway`, restore the plain provider insert and add, after the target
insert:

```ts
  // Only when the option is given, so a test that says nothing about flavor
  // keeps running against an uncatalogued target — which is what pins the
  // fallback to the provider's setting.
  if (options.apiFlavor) {
    await db.insert(catalogModels).values({
      providerId: provider.id,
      modelId: upstreamModel,
      apiFlavor: options.apiFlavor,
    })
  }
```

In `seedTargets`, restore the plain provider insert and add inside the loop,
after the target insert:

```ts
    if (spec.apiFlavor || spec.chatCompletionsPath || spec.responsesPath) {
      await db.insert(catalogModels).values({
        providerId: provider.id,
        modelId: `${spec.name}-model`,
        apiFlavor: spec.apiFlavor ?? null,
        chatCompletionsPath: spec.chatCompletionsPath ?? null,
        responsesPath: spec.responsesPath ?? null,
      })
    }
```

And extend `TargetSpec` with the two path fields:

```ts
export interface TargetSpec {
  /** Provider name, also used to build a distinct upstream model name. */
  name: string
  priority?: number
  weight?: number
  enabled?: boolean
  serviceTier?: ServiceTier | null
  /** Written onto the target's catalog_models row, not the provider or the
   *  target: the model is what owns the flavor. */
  apiFlavor?: ApiFlavor | null
  chatCompletionsPath?: string | null
  responsesPath?: string | null
  adapter?: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/lib/gateway/resolve.test.ts`:

```ts
test('a model flavor overrides the provider for a route target', async () => {
  // The provider still says chat_completions; the model it points at wins.
  const { model } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }],
  })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a target naming a model outside the catalog inherits the provider', async () => {
  // upstream_model is free text, so this is a real arrangement, not a broken
  // one — and it must keep routing rather than drop out of the chain.
  const { model, targets } = await seedTargets({ targets: [{ name: 'p1' }] })
  await db.update(providers).set({ apiFlavor: 'responses' })
    .where(eq(providers.id, targets[0].provider.id))

  const { candidates } = await resolveModel(model.name)

  expect(candidates).toHaveLength(1)
  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a direct provider/model address takes the model flavor', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'openai', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-5', apiFlavor: 'responses',
  })

  const { candidates } = await resolveModel('openai/gpt-5')

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a direct address on a model with no flavor inherits the provider', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'openai', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
    apiFlavor: 'responses',
  }).returning()
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-5' })

  const { candidates } = await resolveModel('openai/gpt-5')

  expect(candidates[0].apiFlavor).toBe('responses')
})
```

The existing `'a direct provider/model address inherits the provider flavor'`
test is superseded by the last one — delete it and its now-inaccurate comment
("No route_targets row stands behind a direct address, so there is nothing that
could have overridden the provider's setting").

- [ ] **Step 3: Run them to verify they fail**

```bash
pnpm test tests/lib/gateway/resolve.test.ts
```

Expected: FAIL — `expected 'chat_completions' to be 'responses'` on the two
tests that set a model flavor.

- [ ] **Step 4: Read the catalog row in both branches**

In `src/lib/gateway/resolve.ts`, `findVirtualModel` joins the catalog:

```ts
  const rows = await db
    .select({ target: routeTargets, provider: providers, catalog: catalogModels })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    // Left, not inner: upstream_model is free text, so a target may name a
    // model the catalog has never seen. That target keeps routing on the
    // provider's settings rather than dropping out of the chain.
    .leftJoin(
      catalogModels,
      and(
        eq(catalogModels.providerId, routeTargets.providerId),
        eq(catalogModels.modelId, routeTargets.upstreamModel),
      ),
    )
    .where(
      and(
        eq(routeTargets.virtualModelId, model.id),
        eq(routeTargets.enabled, true),
        eq(providers.enabled, true),
      ),
    )
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt), asc(routeTargets.id))
```

and its `map` reads the model first:

```ts
    candidates: rows.map(({ target, provider, catalog }) => ({
      targetId: target.id,
      provider,
      upstreamModel: target.upstreamModel,
      priority: target.priority,
      weight: target.weight,
      serviceTier: target.serviceTier,
      apiFlavor: catalog?.apiFlavor ?? provider.apiFlavor,
      breakable: true,
      breakerThreshold: target.breakerThreshold,
      breakerCooldownSeconds: target.breakerCooldownSeconds,
    })),
```

In `resolveDirect`, the catalog row is already selected:

```ts
      apiFlavor: row.catalog.apiFlavor ?? row.provider.apiFlavor,
```

and the comment above the direct candidate becomes accurate again — the model
*can* now set the flavor, but nothing else:

```ts
      // No route_targets row stands behind a direct address, so there is
      // nothing that could have configured a service tier or set up a circuit
      // breaker for it. The flavor comes from the catalog row itself.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/gateway/resolve.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add the arrangement that was impossible before**

One provider serving both flavors is what neither a provider-level nor a
target-level setting could express. It goes in
`tests/lib/gateway/resolve.test.ts`, not `mixed-flavor.test.ts`: that file
drives the handlers through `fakeAdapterByProvider`, which is keyed by provider
name and so cannot tell two models on one provider apart. Its existing tests
need no change — they set flavors through the helper, which now writes catalog
rows, so they go on asserting the same behaviour through the new mechanism.

```ts
test('one provider can serve a chat model and a responses model', async () => {
  const [model] = await db.insert(virtualModels).values({ name: 'house-model' }).returning()
  const [provider] = await db.insert(providers).values({
    name: 'p1', adapter: 'openai', credentials: encryptJson({ apiKey: 'sk-p1' }),
  }).returning()

  await db.insert(catalogModels).values([
    { providerId: provider.id, modelId: 'cc-model' },
    { providerId: provider.id, modelId: 'resp-model', apiFlavor: 'responses' },
  ])
  await db.insert(routeTargets).values([
    { virtualModelId: model.id, providerId: provider.id, upstreamModel: 'cc-model', priority: 0 },
    { virtualModelId: model.id, providerId: provider.id, upstreamModel: 'resp-model', priority: 1 },
  ])

  const { candidates } = await resolveModel('house-model')

  expect(candidates.map((c) => c.apiFlavor)).toEqual(['chat_completions', 'responses'])
})
```

- [ ] **Step 7: Verify the whole suite, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A
git commit -m "$(cat <<'EOF'
feat(gateway): resolve the API flavor from the model

One rule for both address forms: the catalog row's flavor, falling back to the
provider's. A direct provider/model address already had its catalog row in
hand; a virtual model's targets reach theirs through a left join on
(provider_id, upstream_model).

The join is left because upstream_model is free text. A target naming a model
the catalog has never seen must keep routing on the provider's default rather
than vanishing from the chain.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 4: Per-model request paths

**Files:**
- Modify: `src/lib/adapters/types.ts`
- Modify: `src/lib/adapters/registry.ts`
- Modify: `src/lib/adapters/openai/paths.ts`
- Modify: `src/lib/adapters/openai/index.ts` (`FLAVOR_HINT` copy)
- Modify: `src/lib/gateway/resolve.ts`, `execute.ts`, `handler.ts`
- Test: `tests/lib/adapters/registry.test.ts`, `tests/lib/gateway/resolve.test.ts`, `tests/lib/gateway/execute.test.ts`, `tests/lib/gateway/select.test.ts`

**Interfaces:**
- Consumes: the catalog path columns (Task 2) and the catalog join (Task 3).
- Produces:
  - `ModelPathOverrides = { chatCompletionsPath?: string | null; responsesPath?: string | null }` exported from `@/lib/adapters/types`.
  - `createAdapter(provider: ProviderRow, flavor?: ApiFlavor, paths?: ModelPathOverrides | null): ProviderAdapter`.
  - `Candidate.pathOverrides: ModelPathOverrides | null`.
  - `MODEL_PATH_FIELDS` exported from `@/lib/adapters/openai/paths`, consumed by Task 6's dialog.

- [ ] **Step 1: Write the failing adapter tests**

Add to `tests/lib/adapters/registry.test.ts`:

```ts
test('a model path override moves the chat completions endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/v1/api/chat')
})

test('a model path override moves the responses endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ adapter: 'openai_compatible', baseUrl: 'https://api.example/v1' }),
    'responses',
    { responsesPath: '/api/v2/responses' },
  )
  await adapter.chat(chatBody, chatCtx)

  expect(calledPath(fetchSpy)).toBe('https://api.example/v1/api/v2/responses')
})

test('a model that names no path leaves the provider config alone', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.example/v1',
      config: JSON.stringify({ chatCompletionsPath: '/provider/chat' }),
    }),
    'chat_completions',
    { chatCompletionsPath: null, responsesPath: null },
  )
  await adapter.chat(chatBody, chatCtx)

  // null is "this model says nothing", which must not erase the provider's
  // value — the distinction the nullable columns exist to preserve.
  expect(calledPath(fetchSpy)).toBe('https://api.example/v1/provider/chat')
})

test('a model cannot move the models listing path', async () => {
  // Listing is a provider operation: sync calls createAdapter with no model in
  // hand, so a per-model override must not reach it.
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchSpy)

  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.example/v1',
      config: JSON.stringify({ modelsPath: '/api/models' }),
    }),
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )
  await adapter.listModels!({ signal: new AbortController().signal })

  expect(calledPath(fetchSpy)).toBe('https://api.example/v1/api/models')
})

test('gemini accepts model path overrides and ignores them', () => {
  // Gemini's client builds its own URLs, so the only thing worth pinning is
  // that a model carrying paths does not break its construction.
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'g-key' }) }),
    'chat_completions',
    { chatCompletionsPath: '/api/chat' },
  )

  expect(typeof adapter.chat).toBe('function')
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test tests/lib/adapters/registry.test.ts
```

Expected: FAIL — `createAdapter` takes two arguments, so TypeScript rejects the
third.

- [ ] **Step 3: Declare the shape**

In `src/lib/adapters/types.ts`, after `ProviderConfig`:

```ts
/**
 * What one model contributes to adapter construction. The keys are the
 * `ProviderConfig` keys deliberately: `createAdapter` folds these over the
 * provider's config, so the adapters go on reading one object and never learn
 * that a model can carry paths of its own.
 *
 * `null` means "this model names no path", which is not the same as "no path"
 * — it must leave the provider's value standing.
 */
export interface ModelPathOverrides {
  chatCompletionsPath?: string | null
  responsesPath?: string | null
}
```

- [ ] **Step 4: Fold them in at construction**

In `src/lib/adapters/registry.ts`:

```ts
import type {
  ModelPathOverrides, ProviderAdapter, ProviderConfig, ProviderRuntime,
} from './types'

export function createAdapter(
  provider: ProviderRow,
  flavor: ApiFlavor = provider.apiFlavor,
  paths?: ModelPathOverrides | null,
): ProviderAdapter {
  const runtime = withModelPaths(resolveProviderRuntime(provider), paths)
  // …unchanged switch…
}

/**
 * Layers a model's paths over its provider's. Only the keys the model actually
 * names are copied, so an unset one falls through to the provider — and
 * `modelsPath` is not among them, because listing models is a provider
 * operation that happens with no model in hand.
 */
function withModelPaths(
  runtime: ProviderRuntime,
  paths: ModelPathOverrides | null | undefined,
): ProviderRuntime {
  if (!paths?.chatCompletionsPath && !paths?.responsesPath) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  return { ...runtime, config }
}
```

- [ ] **Step 5: Run the adapter tests to verify they pass**

```bash
pnpm test tests/lib/adapters/registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write the failing resolver test**

Add to `tests/lib/gateway/resolve.test.ts`:

```ts
test('a candidate carries the model path overrides', async () => {
  const { model } = await seedTargets({
    targets: [{ name: 'p1', responsesPath: '/api/v2/responses' }],
  })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].pathOverrides).toEqual({
    chatCompletionsPath: null,
    responsesPath: '/api/v2/responses',
  })
})

test('a target outside the catalog carries no path overrides', async () => {
  const { model } = await seedTargets({ targets: [{ name: 'p1' }] })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].pathOverrides).toBeNull()
})
```

- [ ] **Step 7: Run it to verify it fails**

```bash
pnpm test tests/lib/gateway/resolve.test.ts
```

Expected: FAIL — `pathOverrides` does not exist on `Candidate`.

- [ ] **Step 8: Carry the overrides on the candidate**

In `src/lib/gateway/resolve.ts`, import the type and add the field to
`Candidate`, below `apiFlavor`:

```ts
  /** The paths this model is served on, or null when it names none. Only the
   *  OpenAI-shaped adapters read them. */
  pathOverrides: ModelPathOverrides | null
```

`findVirtualModel`'s map — a helper keeps both branches reading the same way:

```ts
      pathOverrides: modelPaths(catalog),
```

`resolveDirect`:

```ts
      pathOverrides: modelPaths(row.catalog),
```

and the helper, near `modelNotFound`:

```ts
/** Null rather than an empty object when there is no row, so a candidate that
 *  could not have overrides is distinguishable from one that has none set. */
function modelPaths(
  catalog: { chatCompletionsPath: string | null; responsesPath: string | null } | null,
): ModelPathOverrides | null {
  if (!catalog) return null
  return {
    chatCompletionsPath: catalog.chatCompletionsPath,
    responsesPath: catalog.responsesPath,
  }
}
```

- [ ] **Step 9: Pass them through the routing loop**

In `src/lib/gateway/execute.ts`, widen the dep and the call:

```ts
  createAdapter: (
    provider: ProviderRow,
    flavor: ApiFlavor,
    paths: ModelPathOverrides | null,
  ) => ProviderAdapter
```

```ts
      adapter = deps.createAdapter(
        candidate.provider, candidate.apiFlavor, candidate.pathOverrides,
      )
```

In `src/lib/gateway/handler.ts`, widen `GatewayDeps.createAdapter` to the same
signature. `defaultCreateAdapter` already matches it.

Add `pathOverrides: null` to the `Candidate` factories in
`tests/lib/gateway/execute.test.ts` and `tests/lib/gateway/select.test.ts`.

- [ ] **Step 10: Correct the flavor hint**

In `src/lib/adapters/openai/index.ts`, `FLAVOR_HINT` still sends operators to a
setting that no longer exists:

```ts
const FLAVOR_HINT =
  'If this endpoint only implements the Responses API, set the model\'s API flavor to "responses" on the Catalog page — or the provider\'s, if every model should follow it.'
```

- [ ] **Step 11: Add the model-facing path fields**

In `src/lib/adapters/openai/paths.ts`, after `PATH_FIELDS`:

```ts
/**
 * The fields a single model may override, for the catalog's gateway dialog.
 * Written out rather than filtered from PATH_FIELDS because the help text is
 * what differs: on a provider form these describe where the provider serves
 * everything, and here they describe one model departing from that.
 */
export const MODEL_PATH_FIELDS = [
  {
    name: 'chatCompletionsPath',
    label: 'Chat completions path',
    placeholder: DEFAULT_PATHS.chatCompletions,
    help: 'Where this one model is served, if not where the provider serves the rest.',
  },
  {
    name: 'responsesPath',
    label: 'Responses path',
    placeholder: DEFAULT_PATHS.responses,
    help: 'Where this one model answers the Responses API.',
  },
] as const
```

- [ ] **Step 12: Verify the whole suite, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A
git commit -m "$(cat <<'EOF'
feat(adapters): let a model override its request paths

The overrides ride into createAdapter as a third argument and are folded over
the provider's config there. They share the config's key names, so both
OpenAI-shaped adapters keep resolving paths exactly as they did and neither
learns that a model can carry paths of its own.

modelsPath is deliberately not among them: catalog sync constructs an adapter
with no model in hand, so listing stays a provider operation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 5: The admin write path and the effective-flavor lookup

**Files:**
- Modify: `src/lib/admin/catalog.ts`
- Test: `tests/lib/admin/catalog.test.ts`

**Interfaces:**
- Consumes: Task 2's columns, `parseProviderPath` and `resolveProviderPaths` from `@/lib/adapters/openai/paths`.
- Produces:
  - `setModelGateway(id: string, input: ModelGatewayInput): Promise<void>` where `ModelGatewayInput = { apiFlavor?: ApiFlavor | null; chatCompletionsPath?: string | null; responsesPath?: string | null }`.
  - `targetGatewayViews(): Promise<Record<string, TargetGatewayView>>` where `TargetGatewayView = { flavor: ApiFlavor; source: 'model' | 'provider' }`.
  - `CatalogListItem` gains `apiFlavor`, `chatCompletionsPath`, `responsesPath`, `providerApiFlavor: ApiFlavor`, and `providerPaths: { chatCompletionsPath: string; responsesPath: string }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/admin/catalog.test.ts`, extending the import from
`@/lib/admin/catalog` with `setModelGateway` and `targetGatewayViews`:

`seedCatalog(ids)` returns the **provider** it created, not the catalog rows —
every test below gets the row id the way the existing ones do, from
`listCatalog()`.

```ts
test('gateway settings are stored on the model and leave the layers alone', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setOverride(before.id, { contextWindow: 999 })

  await setModelGateway(before.id, {
    apiFlavor: 'responses',
    chatCompletionsPath: '/api/chat',
    responsesPath: '/api/v2/responses',
  })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBe('responses')
  expect(item.chatCompletionsPath).toBe('/api/chat')
  expect(item.responsesPath).toBe('/api/v2/responses')
  // These are not layer fields: the override and the value merged from it
  // must come through untouched.
  expect(item.override.contextWindow).toBe(999)
  expect(item.contextWindow).toBe(999)
})

test('a blank path clears the override back to the provider default', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { responsesPath: '/api/v2/responses' })

  await setModelGateway(before.id, { responsesPath: '' })

  const [item] = await listCatalog()
  expect(item.responsesPath).toBeNull()
})

test('an empty flavor clears back to inheriting the provider', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { apiFlavor: 'responses' })

  await setModelGateway(before.id, { apiFlavor: null })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBeNull()
})

test('an unknown flavor is refused', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()

  await expect(
    setModelGateway(item.id, { apiFlavor: 'grpc' as ApiFlavor }),
  ).rejects.toThrow('"grpc" is not a supported API flavor.')
})

test('a path that is really a URL is refused', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()

  await expect(
    setModelGateway(item.id, { responsesPath: 'https://api.example/v1/responses' }),
  ).rejects.toThrow(/not a valid path/)
})

test('the list carries what a blank field would inherit', async () => {
  const provider = await makeProvider('paths-p')
  await db.update(providers)
    .set({ apiFlavor: 'responses', config: JSON.stringify({ responsesPath: '/p/responses' }) })
    .where(eq(providers.id, provider.id))
  await db.insert(catalogModels).values({ providerId: provider.id, modelId: 'gpt-5' })

  const [item] = await listCatalog({ search: 'gpt-5' })

  expect(item.providerApiFlavor).toBe('responses')
  expect(item.providerPaths.responsesPath).toBe('/p/responses')
  expect(item.providerPaths.chatCompletionsPath).toBe('/chat/completions')
})

test('a target reports the flavor its model pins', async () => {
  const provider = await makeProvider('gw-p')
  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'o5-pro', apiFlavor: 'responses',
  })
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'o5-pro',
  })

  const views = await targetGatewayViews()

  expect(views[target.id]).toEqual({ flavor: 'responses', source: 'model' })
})

test('a target whose model pins nothing reports the provider as the source', async () => {
  const provider = await makeProvider('gw-q')
  await db.update(providers).set({ apiFlavor: 'responses' })
    .where(eq(providers.id, provider.id))
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'not-catalogued',
  })

  const views = await targetGatewayViews()

  expect(views[target.id]).toEqual({ flavor: 'responses', source: 'provider' })
})
```

Add whatever imports these need to the top of the file: `eq` from `drizzle-orm`,
`catalogModels` from `@/lib/db/schema`, `createVirtualModel` from
`@/lib/admin/models`, and `type ApiFlavor` from `@/lib/api-flavors`.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test tests/lib/admin/catalog.test.ts
```

Expected: FAIL — `setModelGateway` and `targetGatewayViews` are not exported.

- [ ] **Step 3: Carry the values on the list item**

In `src/lib/admin/catalog.ts`, extend `CatalogListItem`:

```ts
  apiFlavor: ApiFlavor | null
  chatCompletionsPath: string | null
  responsesPath: string | null
  /** What a blank field on this row would inherit, so the dialog can show it
   *  as a placeholder instead of sending an operator to the Providers page. */
  providerApiFlavor: ApiFlavor
  providerPaths: { chatCompletionsPath: string; responsesPath: string }
```

`toItem` takes the provider row it already has a name from. Change its
signature to accept the flavor and the resolved paths, and have `listCatalog`
select them:

```ts
  const rows = await db
    .select({
      model: catalogModels,
      providerName: providers.name,
      providerApiFlavor: providers.apiFlavor,
      providerConfig: providers.config,
    })
    .from(catalogModels)
    .innerJoin(providers, eq(catalogModels.providerId, providers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(providers.name), asc(catalogModels.modelId))
```

and in `toItem`, alongside the existing fields:

```ts
    apiFlavor: row.apiFlavor,
    chatCompletionsPath: row.chatCompletionsPath,
    responsesPath: row.responsesPath,
    providerApiFlavor,
    providerPaths: {
      chatCompletionsPath: resolveProviderPaths(providerConfig).chatCompletions,
      responsesPath: resolveProviderPaths(providerConfig).responses,
    },
```

Call `resolveProviderPaths` once and destructure it rather than twice — the
snippet above shows the fields, not the shape of the final code.
`providerConfig` is the parsed `JSON.parse(row.providerConfig) as ProviderConfig`.

- [ ] **Step 4: Write the two functions**

```ts
export interface ModelGatewayInput {
  apiFlavor?: ApiFlavor | null
  chatCompletionsPath?: string | null
  responsesPath?: string | null
}

/**
 * Writes how the gateway reaches one model. A plain column update: these are
 * not layer fields, so there is no re-merge and `override` is left exactly as
 * it was. A blank path clears back to the provider's, which is what the
 * dialog's placeholder promises.
 */
export async function setModelGateway(
  id: string,
  input: ModelGatewayInput,
): Promise<void> {
  await requireRow(id)

  const patch: Record<string, unknown> = { updatedAt: new Date() }

  // `null` is a value here — "inherit the provider" — not an omission. Only
  // `undefined` leaves a field alone.
  if (input.apiFlavor !== undefined) {
    if (input.apiFlavor !== null && !API_FLAVORS.includes(input.apiFlavor)) {
      throw new Error(`"${input.apiFlavor}" is not a supported API flavor.`)
    }
    patch.apiFlavor = input.apiFlavor
  }
  // parseProviderPath returns null for a blank value and throws on a shape
  // that would fail silently upstream, so validation and clearing are the
  // same call — the same one the provider form goes through.
  if (input.chatCompletionsPath !== undefined) {
    patch.chatCompletionsPath = parseProviderPath(input.chatCompletionsPath ?? '')
  }
  if (input.responsesPath !== undefined) {
    patch.responsesPath = parseProviderPath(input.responsesPath ?? '')
  }

  await db.update(catalogModels).set(patch).where(eq(catalogModels.id, id))
}

export interface TargetGatewayView {
  flavor: ApiFlavor
  /** Which row decided it, so the screen can say where to go and change it. */
  source: 'model' | 'provider'
}

/**
 * The effective flavor of every route target, keyed by target id. A sibling of
 * targetWarnings: the virtual-model page configures routing but no longer owns
 * the flavor, and an operator must still be able to see what a target will do.
 */
export async function targetGatewayViews(): Promise<Record<string, TargetGatewayView>> {
  const targets = await db.select().from(routeTargets)
  if (targets.length === 0) return {}

  const providerRows = await db.select().from(providers)
  const catalogRows = await db.select().from(catalogModels)

  const byProvider = new Map(providerRows.map((row) => [row.id, row]))
  const byKey = new Map(
    catalogRows.map((row) => [`${row.providerId}:${row.modelId}`, row]),
  )

  const views: Record<string, TargetGatewayView> = {}
  for (const target of targets) {
    const model = byKey.get(`${target.providerId}:${target.upstreamModel}`)
    if (model?.apiFlavor) {
      views[target.id] = { flavor: model.apiFlavor, source: 'model' }
      continue
    }
    views[target.id] = {
      flavor: byProvider.get(target.providerId)?.apiFlavor ?? 'chat_completions',
      source: 'provider',
    }
  }

  return views
}
```

Add the imports these need: `API_FLAVORS, type ApiFlavor` from
`@/lib/api-flavors`, and `parseProviderPath, resolveProviderPaths` plus
`type ProviderConfig` from the adapters modules.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/lib/admin/catalog.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify the whole suite, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A
git commit -m "$(cat <<'EOF'
feat(admin): write and read a model's gateway settings

setModelGateway is a plain column update rather than a setOverride: these are
not layer fields, so nothing is merged and the override blob is untouched.
Paths go through the same parseProviderPath the provider form uses, so a URL
or a query string is refused in both places with the same message.

targetGatewayViews gives the virtual-model page the effective flavor per
target, and which row decided it. That page configures routing but no longer
owns the flavor, and an operator still has to be able to see what a target
will do.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 6: The admin UI

**Files:**
- Move: `src/app/(admin)/models/api-flavor-select.tsx` → `src/components/admin/api-flavor-select.tsx`
- Modify: `src/app/(admin)/catalog/actions.ts`
- Modify: `src/app/(admin)/catalog/catalog-forms.tsx`
- Modify: `src/app/(admin)/catalog/catalog-row-actions.tsx`
- Modify: `src/app/(admin)/models/[id]/page.tsx`
- Modify: `README.md:57`

**Interfaces:**
- Consumes: `setModelGateway`, `targetGatewayViews`, the extended `CatalogListItem` (Task 5), `MODEL_PATH_FIELDS` (Task 4), `API_FLAVOR_LABELS` from `@/lib/api-flavors`.
- Produces: `setModelGatewayAction(prev, formData)` in the catalog actions; `GatewaySettingsDialog` in `catalog-forms.tsx`.

- [ ] **Step 1: Move the selector to the shared components directory**

```bash
git mv "src/app/(admin)/models/api-flavor-select.tsx" src/components/admin/api-flavor-select.tsx
```

It has no importers left after Task 1. Update its docstring, which still
describes the dialogs that were deleted:

```tsx
/**
 * The flavor selector. Lives in components/admin because the catalog's gateway
 * dialog is not the only screen that will ever need it.
 *
 * "(inherit)" submits an empty string, which the action turns back into NULL —
 * the value that makes a model follow its provider's setting.
 */
```

- [ ] **Step 2: Add the server action**

In `src/app/(admin)/catalog/actions.ts`, extend the `@/lib/admin/catalog` import
with `setModelGateway` and add, after `clearOverrideAction`:

```ts
/**
 * "(inherit)" submits an empty string, and NULL is what makes a model follow
 * its provider. Anything non-empty goes through unvalidated on purpose: the
 * admin layer owns the enum check, so there is one place that can reject an
 * unknown flavor.
 */
function apiFlavorValue(value: FormDataEntryValue | null): ApiFlavor | null {
  const flavor = String(value ?? '')
  return flavor === '' ? null : (flavor as ApiFlavor)
}

export async function setModelGatewayAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setModelGateway(String(formData.get('id')), {
      apiFlavor: apiFlavorValue(formData.get('apiFlavor')),
      chatCompletionsPath: String(formData.get('chatCompletionsPath') ?? ''),
      responsesPath: String(formData.get('responsesPath') ?? ''),
    })
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not save the gateway settings.',
    }
  }
  revalidatePath('/catalog')
  return { success: 'Gateway settings saved.' }
}
```

Import `type ApiFlavor` from `@/lib/api-flavors`.

- [ ] **Step 3: Build the dialog**

In `src/app/(admin)/catalog/catalog-forms.tsx`, after `OverrideDialog`:

```tsx
export function GatewaySettingsDialog({
  item, open, onOpenChange,
}: {
  item: CatalogListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      title={`Gateway settings for ${item.modelId}`}
      description={`How the gateway calls this model on ${item.providerName}, whichever route reaches it. Blank inherits the provider.`}
      action={setModelGatewayAction}
      submitLabel="Save settings"
      successMessage="Gateway settings saved."
    >
      <input type="hidden" name="id" value={item.id} />

      <div className="space-y-2">
        <Label htmlFor={`gateway-flavor-${item.id}`}>API flavor</Label>
        <ApiFlavorSelect
          id={`gateway-flavor-${item.id}`}
          defaultValue={item.apiFlavor}
          providerDefault={item.providerApiFlavor}
        />
        <p className="text-xs text-muted-foreground">
          Which endpoint this model is called on. Only meaningful for OpenAI-shaped providers.
        </p>
      </div>

      {MODEL_PATH_FIELDS.map((field) => (
        <div key={field.name} className="space-y-2">
          <Label htmlFor={`gateway-${field.name}-${item.id}`}>{field.label}</Label>
          <Input
            id={`gateway-${field.name}-${item.id}`}
            name={field.name}
            defaultValue={item[field.name] ?? ''}
            placeholder={item.providerPaths[field.name]}
          />
          <p className="text-xs text-muted-foreground">{field.help}</p>
        </div>
      ))}
    </FormDialog>
  )
}
```

Add the imports: `ApiFlavorSelect` from `@/components/admin/api-flavor-select`,
`MODEL_PATH_FIELDS` from `@/lib/adapters/openai/paths`, and
`setModelGatewayAction` from `./actions`.

- [ ] **Step 4: Add the menu entry**

In `src/app/(admin)/catalog/catalog-row-actions.tsx`, add the state, the item,
and the dialog:

```tsx
  const [gateway, setGateway] = useState(false)
```

```tsx
          <DropdownMenuItem onClick={() => setOverriding(true)}>Edit overrides</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setGateway(true)}>Gateway settings</DropdownMenuItem>
```

```tsx
      <GatewaySettingsDialog item={item} open={gateway} onOpenChange={setGateway} />
```

extending the `./catalog-forms` import with `GatewaySettingsDialog`.

- [ ] **Step 5: Show the effective flavor on the virtual-model page**

In `src/app/(admin)/models/[id]/page.tsx`, add `targetGatewayViews` to the
`@/lib/admin/catalog` import and to whatever `Promise.all` already fetches
`targetWarnings()` (read the file around line 60 — mirror how `warnings` is
fetched and named). Then replace the cell Task 1 left showing the provider's
flavor:

```tsx
                  <TableCell>
                    <Badge variant="outline">
                      {API_FLAVOR_LABELS[gatewayViews[target.id]?.flavor ?? 'chat_completions']}
                    </Badge>
                    <span className="ml-2 text-xs text-muted-foreground">
                      from {gatewayViews[target.id]?.source ?? 'provider'}
                    </span>
                  </TableCell>
```

Import `API_FLAVOR_LABELS` from `@/lib/api-flavors`. The `providers.find(…)`
expression from Task 1 goes; check whether `providers` is still used elsewhere
on the page (it is — `AddTargetDialog`) before removing anything else.

- [ ] **Step 6: Correct the README**

`README.md:57` reads:

```
- Hosted tools (`web_search`, `file_search`, …) need a target whose API flavor
```

Read the full sentence and rewrite it around the model rather than the target —
something like "need a model whose API flavor is `responses`". Keep the
surrounding lines' voice.

- [ ] **Step 7: Check it in the browser**

Never `pnpm dev` — that drives the developer's own database on 5432.

```bash
pnpm dev:test-db
```

Then at `http://localhost:3001`: open Catalog, use the ⋮ menu on a model, set
its flavor to Responses and a responses path, save, reopen the dialog and
confirm both came back. Open a virtual model with a target pointing at that
model and confirm the row reads `Responses · from model`. Stop the server when
done; leave the developer's own on 3000 alone.

- [ ] **Step 8: Verify the whole suite, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A
git commit -m "$(cat <<'EOF'
feat(catalog): edit a model's gateway settings from the admin UI

A second dialog beside the override one, because the two save through
different mechanisms: an override goes through the layer merge and has
per-field clear buttons, while a flavor or a path is a plain column write.

The virtual-model page keeps showing a flavor per target, now the effective
one with the row that decided it. That page configures routing but no longer
owns the setting, and removing the selector without replacing it would have
made the flavor invisible exactly where an operator looks for it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ER37VJtkk3F2eRraS4kJAr
EOF
)"
```

---

## Task 7: End-to-end verification

No new behaviour — this is the gate before the work is called done, per
`superpowers:verification-before-completion`.

- [ ] **Step 1: Run everything from a clean database**

```bash
psql postgres://babellm:babellm@localhost:5434/postgres \
  -c 'DROP DATABASE IF EXISTS babellm_test WITH (FORCE)'
pnpm test && pnpm typecheck && pnpm lint
```

Expected: PASS. This proves the migration chain applies from nothing, which the
deleted `0008` makes worth re-checking.

- [ ] **Step 2: Confirm the removal is total**

```bash
grep -rn "route_targets.*api_flavor\|routeTargets.apiFlavor" src tests drizzle
grep -rn "target's API flavor\|target whose API flavor" src README.md
```

Expected: no output from either.

- [ ] **Step 3: Confirm the spec's claims hold**

Re-read `docs/superpowers/specs/2026-08-18-per-model-api-flavor-design.md` and
check each section against the code. Anything the implementation did
differently — for a good reason — gets the spec updated in the same commit, so
the document does not start lying.

- [ ] **Step 4: Report**

Summarise what landed, quoting the actual `pnpm test` tail. Then ask how to
integrate, per `superpowers:finishing-a-development-branch` — noting that this
branch is not `main` and is 30+ commits ahead of it.

---

## Self-Review Notes

Checked against the spec:

- §1 Schema → Tasks 1 (deletion) and 2 (columns).
- §2 Resolution → Task 3 (flavor, both address forms, left join) and Task 4 (`pathOverrides` on `Candidate`).
- §3 Path plumbing → Task 4, including `MODEL_PATH_FIELDS` and the `FLAVOR_HINT` correction.
- §4 Admin UI → Task 5 (write path, `targetGatewayViews`) and Task 6 (move, dialog, menu, detail page, README).
- §5 Testing → the helper change is Task 3 Step 1; each area's coverage sits in the task that builds it.
- Out-of-scope items are absent from every task.

Names used consistently throughout: `setModelGateway`, `targetGatewayViews`,
`ModelPathOverrides`, `MODEL_PATH_FIELDS`, `GatewaySettingsDialog`,
`setModelGatewayAction`, `Candidate.pathOverrides`.
