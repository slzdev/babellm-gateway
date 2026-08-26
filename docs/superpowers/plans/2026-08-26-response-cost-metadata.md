# Per-request cost in response metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the cost the gateway already computes to the client, nested inside `usage.cost`, on every Chat and Responses request, streaming and not.

**Architecture:** Move the catalog price lookup ahead of the response instead of leaving it in the fire-and-forget logging path. A single serializer turns the internal `CostBreakdown` into the wire `CostPayload`; two hooks (`Ingress.finish` for buffered responses, `StreamProtocol.attachCost` for streamed ones) write it into `usage`. The logging path is then re-pointed at the same computed value so the client's number, the log row, and the billed spend are one object.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, Postgres, Vitest, OpenAI SDK types.

**Spec:** `docs/superpowers/specs/2026-08-26-response-cost-metadata-design.md`

> **Superseded in one detail.** After this plan was executed, the wire keys lost
> their `_usd` suffix — `input_usd` → `input`, and likewise for `cached`,
> `output` and `total` — because the sibling `currency` field already says what
> the unit is. The code samples below still show the original names. The spec
> and `README.md` carry the shipped shape; prefer them.

## Global Constraints

- **Test database:** this worktree's `.env.test` points at `babellm_test_cost_metadata` on **port 5434**. Never repoint it at 5432. Never run `pnpm test:db:down` — it destroys sibling worktrees' containers. The container is already running.
- **Run tests with:** `pnpm test` (full) or `pnpm vitest run <path>` (single file).
- **Currency:** the `currency` field is the constant string `"USD"`. No other currency ships.
- **Representation:** all money is a **string** with **9 decimal places**, exactly as `computeCost` produces. Never convert to `number` on the wire.
- **Unpriceable requests** emit `"cost": null` — an explicit null, never an absent key, never `0`.
- **Absent usage:** when the upstream reported no `usage` object, attach nothing. Never fabricate a `usage` object to carry a null cost.
- **Catalog rates (`pricing`) never reach the client.** They stay in `CostBreakdown`, which is what the log stores (`src/lib/logs/postgres.ts:103` writes `entry.cost.pricing` to its own column).
- **A price lookup must never fail a request.** Every `priceFor()` call on the response path carries `.catch(() => null)` attached at creation.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `test:`, `refactor:`, `docs:`), matching the existing history.

---

### Task 1: The cost serializer

The pure, dependency-free foundation: one function that produces the wire shape, and one that attaches it to a response. Everything else calls these, so Chat and Responses cannot drift.

**Files:**
- Create: `src/lib/gateway/cost.ts`
- Test: `tests/lib/gateway/cost.test.ts`

**Interfaces:**
- Consumes: `CostBreakdown` from `@/lib/logs/types` — `{ inputUsd, cachedUsd, outputUsd, totalUsd, pricing }`, all `string | null` except `pricing`.
- Produces:
  - `interface CostPayload { currency: 'USD'; input_usd: string | null; cached_usd: string | null; output_usd: string | null; total_usd: string | null }`
  - `costPayload(cost: CostBreakdown | null): CostPayload | null`
  - `withUsageCost<T extends { usage?: unknown }>(target: T, cost: CostPayload | null): T`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/gateway/cost.test.ts`:

```ts
import { expect, test } from 'vitest'
import { costPayload, withUsageCost } from '@/lib/gateway/cost'
import type { CostBreakdown } from '@/lib/logs/types'

const breakdown: CostBreakdown = {
  inputUsd: '0.003000000',
  cachedUsd: '0.000000000',
  outputUsd: '0.005100000',
  totalUsd: '0.008100000',
  pricing: {
    inputPerMtok: '2.500000',
    cachedInputPerMtok: '0.250000',
    outputPerMtok: '15.000000',
  },
}

test('renders the breakdown in snake_case with a currency', () => {
  expect(costPayload(breakdown)).toEqual({
    currency: 'USD',
    input_usd: '0.003000000',
    cached_usd: '0.000000000',
    output_usd: '0.005100000',
    total_usd: '0.008100000',
  })
})

test('never leaks the catalog rates to the client', () => {
  // The whole reason this function exists rather than shipping CostBreakdown
  // directly. An exact key list, not a `pricing` check: a future field added
  // to CostBreakdown must fail here rather than silently reach every caller.
  expect(Object.keys(costPayload(breakdown)!).sort()).toEqual([
    'cached_usd', 'currency', 'input_usd', 'output_usd', 'total_usd',
  ])
})

test('an unpriceable request serializes to null, not to zeroes', () => {
  expect(costPayload(null)).toBeNull()
})

test('keeps money as strings at nine decimals', () => {
  const payload = costPayload(breakdown)!
  expect(typeof payload.total_usd).toBe('string')
  expect(payload.total_usd).toBe('0.008100000')
})

test('attaches the cost inside the usage object', () => {
  const res = { id: 'chatcmpl-1', usage: { prompt_tokens: 5, completion_tokens: 2 } }
  expect(withUsageCost(res, costPayload(breakdown))).toEqual({
    id: 'chatcmpl-1',
    usage: {
      prompt_tokens: 5,
      completion_tokens: 2,
      cost: {
        currency: 'USD',
        input_usd: '0.003000000',
        cached_usd: '0.000000000',
        output_usd: '0.005100000',
        total_usd: '0.008100000',
      },
    },
  })
})

test('attaches an explicit null so a client can tell unpriced from unsupported', () => {
  const res = { id: 'chatcmpl-1', usage: { prompt_tokens: 5 } }
  expect(withUsageCost(res, null).usage).toEqual({ prompt_tokens: 5, cost: null })
})

test('never invents a usage object that upstream did not report', () => {
  // A provider with disableStreamUsage measured nothing. Fabricating a usage
  // object to carry `cost: null` would claim a measurement never taken.
  const res = { id: 'chatcmpl-1' }
  expect(withUsageCost(res, costPayload(breakdown))).toEqual({ id: 'chatcmpl-1' })
  expect('usage' in withUsageCost(res, null)).toBe(false)
})

test('leaves a null usage alone rather than spreading it', () => {
  // ChatCompletionChunk types usage as `CompletionUsage | null`, so null is a
  // shape that actually arrives, not a defensive hypothetical.
  const res = { id: 'chatcmpl-1', usage: null }
  expect(withUsageCost(res, null)).toEqual({ id: 'chatcmpl-1', usage: null })
})

test('does not mutate its input', () => {
  const usage = { prompt_tokens: 5 }
  const res = { id: 'chatcmpl-1', usage }
  withUsageCost(res, costPayload(breakdown))
  expect(usage).toEqual({ prompt_tokens: 5 })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/gateway/cost.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/gateway/cost"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/gateway/cost.ts`:

```ts
import type { CostBreakdown } from '@/lib/logs/types'

/**
 * The wire shape of a request's cost.
 *
 * Deliberately narrower than CostBreakdown: the catalog's per-Mtok rates stay
 * out of it. Clients see what they were charged and how it splits; the rates
 * that produced those numbers are the operator's business and stay in the
 * request log and the admin UI.
 *
 * Money is a string at nine decimals, matching what computeCost produces and
 * what the log stores. Numbers would reintroduce, at the client, exactly the
 * float error the string representation exists to avoid.
 */
export interface CostPayload {
  currency: 'USD'
  input_usd: string | null
  cached_usd: string | null
  output_usd: string | null
  total_usd: string | null
}

/**
 * Renders a computed cost for the client, or null when the request could not
 * be priced.
 *
 * Null propagates rather than collapsing to zeroes, for the reason
 * `computeCost` returns null in the first place: a response claiming $0.00 for
 * an uncatalogued model is lying.
 */
export function costPayload(cost: CostBreakdown | null): CostPayload | null {
  if (!cost) return null
  return {
    currency: 'USD',
    input_usd: cost.inputUsd,
    cached_usd: cost.cachedUsd,
    output_usd: cost.outputUsd,
    total_usd: cost.totalUsd,
  }
}

/**
 * Writes the cost into a response's `usage` object.
 *
 * A target with no usage is returned untouched. An absent usage object means
 * the provider measured nothing — a clone that omits the field, or one
 * configured with disableStreamUsage — and inventing one to carry a null cost
 * would report a measurement that was never taken.
 *
 * The cast is deliberate and confined here. `ChatCompletion`,
 * `ChatCompletionChunk` and `Response` are the OpenAI SDK's own types and
 * cannot express this extension; keeping the one cast in this function stops
 * it spreading through the ingresses.
 */
export function withUsageCost<T extends { usage?: unknown }>(
  target: T,
  cost: CostPayload | null,
): T {
  if (!target.usage) return target
  return { ...target, usage: { ...(target.usage as object), cost } } as T
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/gateway/cost.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gateway/cost.ts tests/lib/gateway/cost.test.ts
git commit -m "feat(gateway): add the client-facing cost serializer"
```

---

### Task 2: Cost on buffered responses

Wires the price lookup into the non-streaming path for both ingresses. `Ingress.finish` gains a third parameter, which is a compile-breaking change — both protocol files must be updated in this task or nothing builds.

The logging path is deliberately left alone here; it keeps computing its own cost until Task 4. Within `priceFor`'s 60s TTL that duplicate is a `Map` hit, not a second query.

**Files:**
- Modify: `tests/helpers/gateway.ts` (add `seedPrices`)
- Modify: `src/lib/gateway/handler.ts` (the `Ingress` interface, and the non-streaming branch near the end of `runGatewayRequest`)
- Modify: `src/lib/gateway/protocols/chat.ts` (`chatIngress.finish`)
- Modify: `src/lib/gateway/protocols/responses.ts` (`responsesIngress.finish`)
- Test: `tests/gateway/chat.test.ts`, `tests/gateway/responses-ingress.test.ts`

**Interfaces:**
- Consumes: `costPayload`, `withUsageCost` from `@/lib/gateway/cost` (Task 1). `priceFor`, `computeCost` from `@/lib/pricing`.
- Produces:
  - `Ingress.finish(res: Res, identity: IdentityOptions, cost: CostPayload | null): Res` — note the **already-serialized** `CostPayload`, so no ingress calls `costPayload` itself.
  - `seedPrices(providerId: string, modelId: string, prices: { inputPerMtok?: string; cachedInputPerMtok?: string; outputPerMtok?: string }): Promise<void>` in `tests/helpers/gateway.ts`.

- [ ] **Step 1: Add the pricing test helper**

`seedGateway` inserts no `catalog_models` row, while `seedTargets` inserts one whenever `apiFlavor` is set. A plain insert therefore works for one and violates `catalog_models_provider_model_idx` for the other. One upsert covers both.

Append to `tests/helpers/gateway.ts` (and add `catalogModels` to the existing `@/lib/db/schema` import if it is not already there — it is):

```ts
/**
 * Gives a provider's model catalog prices.
 *
 * An upsert rather than an insert because seedTargets already writes a
 * catalog_models row whenever a target declares an apiFlavor, and
 * catalog_models_provider_model_idx makes a second insert a constraint
 * violation. Callers should not have to know which seeder they used.
 */
export async function seedPrices(
  providerId: string,
  modelId: string,
  prices: {
    inputPerMtok?: string
    cachedInputPerMtok?: string
    outputPerMtok?: string
  },
) {
  await db
    .insert(catalogModels)
    .values({ providerId, modelId, ...prices })
    .onConflictDoUpdate({
      target: [catalogModels.providerId, catalogModels.modelId],
      set: prices,
    })
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/gateway/chat.test.ts`. Extend the existing import from `../helpers/gateway` to include `seedPrices`, and add these imports at the top of the file:

```ts
import { clearPriceCache } from '@/lib/pricing'
```

Add `clearPriceCache()` to the existing `beforeEach` body (after `await resetDb()`) — the price cache is module-level and survives between tests, so without this a test that seeds prices poisons the next test that expects none.

Then add the tests. Note `upstreamCompletion` in this file reports `prompt_tokens: 5, completion_tokens: 2`; these tests use their own completion with round numbers so the arithmetic is readable:

```ts
const pricedCompletion = {
  ...upstreamCompletion,
  usage: {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 0 },
  },
}

test('returns the cost breakdown inside usage', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(json.usage.cost).toEqual({
    currency: 'USD',
    input_usd: '1.000000000',
    cached_usd: '0.000000000',
    output_usd: '3.000000000',
    total_usd: '4.000000000',
  })
})

test('leaves the token counts untouched when attaching cost', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(json.usage.prompt_tokens).toBe(1_000_000)
  expect(json.usage.completion_tokens).toBe(1_000_000)
  expect(json.usage.total_tokens).toBe(2_000_000)
})

test('never publishes the catalog rates to the client', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )

  expect(JSON.stringify(await res.json())).not.toContain('per_mtok')
})

test('bills cached tokens at the cached rate without double-charging the prompt', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '0',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({
      chat: vi.fn().mockResolvedValue({
        ...upstreamCompletion,
        usage: {
          prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000,
          prompt_tokens_details: { cached_tokens: 400_000 },
        },
      }),
    }),
  )
  const json = await res.json()

  // 600k at the full rate + 400k cached — not 1M at full plus a second charge.
  expect(json.usage.cost.input_usd).toBe('0.600000000')
  expect(json.usage.cost.cached_usd).toBe('0.100000000')
  expect(json.usage.cost.total_usd).toBe('0.700000000')
})

test('an unpriced model returns an explicit null cost, not zeroes', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  // Null, not absent: a client must be able to tell "this model has no catalog
  // price" from "this gateway predates the feature".
  expect(json.usage).toHaveProperty('cost')
  expect(json.usage.cost).toBeNull()
})

test('a half-priced catalog row returns null rather than half a cost', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', { inputPerMtok: '1.000000' })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )

  expect((await res.json()).usage.cost).toBeNull()
})

test('a response with no usage gets no fabricated usage object', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
  const { usage: _usage, ...noUsage } = upstreamCompletion

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(noUsage) }),
  )
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.usage).toBeUndefined()
})

test('a catalog lookup failure costs the breakdown, not the completion', async () => {
  const { apiKey } = await seedGateway()
  vi.spyOn(pricing, 'priceFor').mockRejectedValue(new Error('catalog is down'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(pricedCompletion) }),
  )
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.choices[0].message.content).toBe('hello')
  expect(json.usage.cost).toBeNull()
})
```

That last test needs a namespace import alongside the existing ones:

```ts
import * as pricing from '@/lib/pricing'
```

And add to `tests/gateway/responses-ingress.test.ts` — extend its `../helpers/gateway` import with `seedPrices`, add `import { clearPriceCache } from '@/lib/pricing'`, and add `clearPriceCache()` to its `beforeEach`:

```ts
test('returns the cost breakdown inside usage', async () => {
  const { apiKey, targets } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }],
  })
  await seedPrices(targets[0].provider.id, 'p1-model', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({
      p1: {
        respond: vi.fn().mockResolvedValue({
          ...response('resp_upstream'),
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
        }),
      },
    }),
  )
  const body = await res.json()

  expect(body.usage.cost).toEqual({
    currency: 'USD',
    input_usd: '1.000000000',
    cached_usd: '0.000000000',
    output_usd: '3.000000000',
    total_usd: '4.000000000',
  })
  // The Responses dialect's own token spelling survives untouched.
  expect(body.usage.input_tokens).toBe(1_000_000)
})

test('an unpriced Responses model returns an explicit null cost', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({
      p1: { respond: vi.fn().mockResolvedValue(response('resp_upstream')) },
    }),
  )

  expect((await res.json()).usage.cost).toBeNull()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/gateway/chat.test.ts tests/gateway/responses-ingress.test.ts`
Expected: FAIL — the new tests report `usage.cost` as `undefined` rather than an object or null. Every pre-existing test in both files still passes.

- [ ] **Step 4: Widen the `Ingress.finish` contract**

In `src/lib/gateway/handler.ts`, add the import:

```ts
import { costPayload, type CostPayload } from './cost'
```

and change the `finish` line in the `Ingress` interface:

```ts
  /** The last transformation before the client sees the response: gateway
   *  identity, and the cost this request is being charged. `cost` is already
   *  serialized, so no ingress has to know how CostBreakdown is rendered. */
  finish(res: Res, identity: IdentityOptions, cost: CostPayload | null): Res
```

- [ ] **Step 5: Update both ingresses**

In `src/lib/gateway/protocols/chat.ts`, add the import and change `finish`:

```ts
import { withUsageCost } from '../cost'
```

```ts
  finish: (res, identity, cost) => withUsageCost(rewriteCompletion(res, identity), cost),
```

In `src/lib/gateway/protocols/responses.ts`, the same:

```ts
import { withUsageCost } from '../cost'
```

```ts
  finish: (res, identity, cost) => withUsageCost(rewriteResponse(res, identity), cost),
```

- [ ] **Step 6: Price the request in the non-streaming branch**

In `src/lib/gateway/handler.ts`, find the non-streaming branch near the end of `runGatewayRequest` — it currently reads:

```ts
    dropped = ingress.droppedFor(result.candidate, bodyFor(result.candidate, body))

    // Built before logging: logging after the response has been constructed
    // means a throw building the response can no longer race a second,
    // contradictory log line against this one for the same request_id.
    const completion = ingress.finish(result.value, identity)
```

Replace from `dropped = ...` through the `const completion = ...` line with:

```ts
    dropped = ingress.droppedFor(result.candidate, bodyFor(result.candidate, body))

    // The catalog may never fail a request. A price lookup that throws costs
    // the client its cost breakdown, not its completion — so the rejection is
    // swallowed at creation rather than caught at the await, which also keeps
    // the streaming path (where this promise may never be awaited at all)
    // from raising an unhandled rejection.
    const prices = await priceFor(
      result.candidate.provider.id,
      result.candidate.upstreamModel,
    ).catch(() => null)
    const usage = ingress.usageOf(result.value)
    const cost = computeCost(prices, usage)

    // Built before logging: logging after the response has been constructed
    // means a throw building the response can no longer race a second,
    // contradictory log line against this one for the same request_id.
    const completion = ingress.finish(result.value, identity, costPayload(cost))
```

Then change the `log(...)` call immediately below it to reuse the usage already
computed, replacing `usage: ingress.usageOf(result.value),` with `usage,`:

```ts
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage,
      response: completion,
    })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gateway/chat.test.ts tests/gateway/responses-ingress.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. A `finish` call with two arguments anywhere would fail here.

- [ ] **Step 9: Commit**

```bash
git add src/lib/gateway/handler.ts src/lib/gateway/protocols/chat.ts src/lib/gateway/protocols/responses.ts tests/helpers/gateway.ts tests/gateway/chat.test.ts tests/gateway/responses-ingress.test.ts
git commit -m "feat(gateway): return the cost breakdown on buffered responses"
```

---

### Task 3: Cost on streamed responses

The sharp one. Usage arrives on the last chunk, so the cost must be injected mid-stream — without putting a catalog query on the time-to-first-token path.

The price promise is created but **not awaited** before the response is returned; it is awaited inside the relay loop only on a chunk that carries usage, which is the final one. By then it resolved long ago, so the await costs a microtask.

`sse.ts` stays ignorant of pricing. It receives a `costFor` callback and the handler owns the lookup — matching how `sse.ts` already takes `onSettle` rather than knowing about logging.

**Files:**
- Modify: `src/lib/gateway/sse.ts` (`StreamProtocol`, `StreamCapture`, `sseResponse`, the relay loop)
- Modify: `src/lib/gateway/protocols/chat.ts` (`chatStreamProtocol.attachCost`)
- Modify: `src/lib/gateway/protocols/responses.ts` (`responsesStreamProtocol.attachCost`)
- Modify: `src/lib/gateway/handler.ts` (the streaming branch)
- Test: `tests/gateway/chat-stream.test.ts`, `tests/gateway/responses-ingress.test.ts`

**Interfaces:**
- Consumes: `costPayload`, `withUsageCost`, `CostPayload` from `@/lib/gateway/cost` (Task 1). `seedPrices` from `tests/helpers/gateway.ts` (Task 2).
- Produces:
  - `StreamProtocol.attachCost(chunk: Chunk, cost: CostPayload | null): Chunk`
  - `StreamCapture.cost: CostBreakdown | null` — the **internal** breakdown, not the wire payload. Task 4 reads this.
  - `sseResponse(..., capture?: CaptureOptions, costFor?: (usage: LogUsage) => Promise<CostBreakdown | null>)` — a seventh, optional parameter.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/chat-stream.test.ts`. Extend its `../helpers/gateway` import with `seedPrices`, and add:

```ts
import { clearPriceCache } from '@/lib/pricing'
```

Add `clearPriceCache()` to the existing `beforeEach` body, after `await resetDb()`.

Then the tests:

```ts
const usageChunk = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [],
  usage: {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 0 },
  },
}

const contentChunk = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
}

test('the final usage chunk carries the cost breakdown', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf([contentChunk, usageChunk]) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{
    usage?: { cost?: unknown }
  }>

  const withUsage = chunks.filter((c) => c.usage)
  expect(withUsage).toHaveLength(1)
  expect(withUsage[0].usage!.cost).toEqual({
    currency: 'USD',
    input_usd: '1.000000000',
    cached_usd: '0.000000000',
    output_usd: '3.000000000',
    total_usd: '4.000000000',
  })
})

test('content chunks are not given a usage object just to carry a cost', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf([contentChunk, usageChunk]) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{ usage?: unknown }>

  expect(chunks[0].usage).toBeUndefined()
})

test('a stream whose provider reports no usage carries no cost anywhere', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf([contentChunk]) as never }),
  )
  const text = await res.text()

  expect(text).not.toContain('"cost"')
  expect(sseTerminated(text)).toBe(true)
})

test('an unpriced streaming model reports an explicit null cost', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf([contentChunk, usageChunk]) as never }),
  )
  const chunks = parseSseChunks(await res.text()) as Array<{
    usage?: { cost?: unknown }
  }>

  const withUsage = chunks.filter((c) => c.usage)
  expect(withUsage[0].usage!.cost).toBeNull()
})

test('a catalog failure costs the breakdown, not the stream', async () => {
  const { apiKey } = await seedGateway()
  vi.spyOn(pricing, 'priceFor').mockRejectedValue(new Error('catalog is down'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chatStream: streamOf([contentChunk, usageChunk]) as never }),
  )
  const text = await res.text()
  const chunks = parseSseChunks(text) as Array<{ usage?: { cost?: unknown } }>

  expect(sseTerminated(text)).toBe(true)
  expect(chunks.filter((c) => c.usage)[0].usage!.cost).toBeNull()
})
```

The last test needs `import * as pricing from '@/lib/pricing'` added to the file.

And add to `tests/gateway/responses-ingress.test.ts`:

```ts
test('the response.completed event carries the cost breakdown', async () => {
  const { apiKey, targets } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }],
  })
  await seedPrices(targets[0].provider.id, 'p1-model', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  async function* respondStream() {
    yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
    yield {
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: 'resp_1', model: 'up', output: [], status: 'completed',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
      },
    }
  }

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', stream: true }, apiKey),
    fakeAdapterByProvider({ p1: { respondStream: respondStream as never } }),
  )
  const text = await res.text()

  const completed = text
    .split('\n\n')
    .find((block) => block.startsWith('event: response.completed'))!
  const payload = JSON.parse(
    completed.split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim(),
  )

  expect(payload.response.usage.cost).toEqual({
    currency: 'USD',
    input_usd: '1.000000000',
    cached_usd: '0.000000000',
    output_usd: '3.000000000',
    total_usd: '4.000000000',
  })
  // The virtual model rewrite still happens; attaching cost must not undo it.
  expect(payload.response.model).toBe('house-model')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/gateway/chat-stream.test.ts tests/gateway/responses-ingress.test.ts`
Expected: FAIL — `usage.cost` is `undefined` in the new tests. Pre-existing tests pass.

- [ ] **Step 3: Extend the stream contract in `sse.ts`**

In `src/lib/gateway/sse.ts`, change the type import line to add `CostBreakdown`:

```ts
import type { CostBreakdown, LogUsage } from '@/lib/logs/types'
```

and add:

```ts
import { costPayload, type CostPayload } from './cost'
```

Add to the `StreamProtocol` interface, after `usageOf`:

```ts
  /** Writes the cost into a chunk that carries usage. Called only for chunks
   *  whose usageOf() returned non-null, so an implementation never has to
   *  invent a usage object. */
  attachCost(chunk: Chunk, cost: CostPayload | null): Chunk
```

Add to the `StreamCapture` interface, after `usage`:

```ts
  /** The cost of `usage`, as the client was told it.
   *
   * The internal CostBreakdown, not the wire CostPayload: the request log
   * stores the catalog rates in their own column (logs/postgres.ts), so
   * narrowing this to the client's shape would silently strip `pricing` out
   * of every logged row. */
  cost: CostBreakdown | null
```

Initialize it in `sseResponse`'s `captured` literal:

```ts
  const captured: StreamCapture = {
    usage: null, cost: null, text: '', bytes: 0, truncated: false,
    error: null, firstDeltaAt: null,
  }
```

- [ ] **Step 4: Take the callback and inject in the relay loop**

Add a seventh parameter to `sseResponse`, after `capture`:

```ts
  capture?: CaptureOptions,
  costFor?: (usage: LogUsage) => Promise<CostBreakdown | null>,
): Response {
```

Then in the relay loop's `for await` body, replace:

```ts
          // include_usage puts this on the final chunk; a provider that omits
          // it simply leaves captured.usage null.
          const usage = protocol.usageOf(chunk)
          if (usage) captured.usage = usage
```

with:

```ts
          // include_usage puts this on the final chunk; a provider that omits
          // it simply leaves captured.usage null.
          const usage = protocol.usageOf(chunk)
          // The chunk actually framed. Reassigned only for a usage-bearing
          // chunk, so a content delta is relayed as the identical object.
          let outgoing = chunk
          if (usage) {
            captured.usage = usage
            if (costFor) {
              // The only await in this loop that is not pulling from upstream.
              // It resolves a promise the handler started before the response
              // was returned, so by the time usage arrives — the last chunk —
              // it has long since settled and this costs a microtask. Placing
              // it here rather than before the response is what keeps a
              // catalog query off time-to-first-token.
              captured.cost = await costFor(usage)
              outgoing = protocol.attachCost(chunk, costPayload(captured.cost))
            }
          }
```

and change the enqueue at the end of the loop body from `protocol.frame(chunk, identity)` to:

```ts
          controller.enqueue(protocol.frame(outgoing, identity))
```

Leave the `accumulate` call above it reading `chunk` — cost never touches assistant text, so capture is unaffected either way, and passing the original keeps that obvious.

- [ ] **Step 5: Implement `attachCost` in both protocols**

In `src/lib/gateway/protocols/chat.ts`, add to `chatStreamProtocol` after `usageOf`:

```ts
  attachCost: (chunk, cost) => withUsageCost(chunk, cost),
```

(`withUsageCost` is already imported by Task 2.)

In `src/lib/gateway/protocols/responses.ts`, add to `responsesStreamProtocol` after `usageOf`:

```ts
  attachCost: (event, cost) => {
    // Usage hangs off the response object, not the event, so this reaches one
    // level deeper than chat's. Events with no response — the deltas — are
    // returned untouched.
    if (!('response' in event) || !event.response) return event
    return {
      ...event,
      response: withUsageCost(event.response as { usage?: unknown }, cost),
    } as ResponseStreamEvent
  },
```

- [ ] **Step 6: Wire the handler's streaming branch**

In `src/lib/gateway/handler.ts`, inside the `if (stream) { ... }` branch, insert after the `dropped = ingress.droppedFor(...)` line and before the `const captureOptions = ...` line:

```ts
      // Started, deliberately not awaited: handler.ts must put nothing
      // between execute() and the response, or it lands on
      // time-to-first-token. The relay awaits this only on the chunk that
      // carries usage — the last one — by which point it has long resolved.
      //
      // The .catch is attached here rather than at the await because a stream
      // that ends without usage never awaits it at all, and an unattended
      // rejection would take down the process precisely when the database is
      // already in trouble.
      const prices = priceFor(
        result.candidate.provider.id,
        result.candidate.upstreamModel,
      ).catch(() => null)
```

Then add the seventh argument to the `sseResponse(...)` call, after `captureOptions`:

```ts
        captureOptions,
        async (usage) => computeCost(await prices, usage),
      )
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gateway/chat-stream.test.ts tests/gateway/responses-ingress.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. A `StreamProtocol` implementation missing `attachCost` would fail here — `tests/lib/gateway/` may contain protocol stubs; if any fails to compile, add `attachCost: (chunk) => chunk` to the stub with a comment saying the test does not exercise cost.

- [ ] **Step 9: Commit**

```bash
git add src/lib/gateway/sse.ts src/lib/gateway/handler.ts src/lib/gateway/protocols/chat.ts src/lib/gateway/protocols/responses.ts tests/gateway/chat-stream.test.ts tests/gateway/responses-ingress.test.ts
git commit -m "feat(gateway): return the cost breakdown on streamed responses"
```

---

### Task 4: One cost, three destinations

The response path now computes a cost that the logging path computes again a moment later. Thread the first one through and delete the second, so the number the client received, the number in the log row, and the number billed against the key's budget are provably the same object rather than two lookups that could straddle a price change or a cache expiry.

**Files:**
- Modify: `src/lib/gateway/handler.ts` (`LogExtra`, `writeLog`, both `log(...)` call sites)
- Test: `tests/gateway/request-logging.test.ts`

**Interfaces:**
- Consumes: `StreamCapture.cost` (Task 3), and the `cost` local in the non-streaming branch (Task 2).
- Produces: `LogExtra.cost?: CostBreakdown | null`. `writeLog` no longer calls `priceFor`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/request-logging.test.ts` — it already imports `clearPriceCache`, `catalogModels`, `db`, and `waitForLogs`. Extend its `../helpers/gateway` import with `seedPrices`:

```ts
test('the logged cost is the same number the client was given', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  const clientTotal = (await res.json()).usage.cost.total_usd
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBe(Number(clientTotal))
})

test('the log keeps the catalog rates the client never sees', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  // The regression this guards: narrowing StreamCapture.cost or LogExtra.cost
  // to the client's CostPayload would strip `pricing` out of every row.
  // Note LogDetail exposes `pricing` at the top level, not under `cost` —
  // see the read path in src/lib/logs/postgres.ts.
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.id)
  expect(detail?.pricing).toMatchObject({
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
})

test('a streamed request logs the cost its final chunk carried', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  async function* chatStream() {
    yield {
      id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
    yield {
      id: 'chatcmpl-upstream', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4o-mini', choices: [],
      usage: {
        prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterDeps({ chatStream: chatStream as never }),
  )
  await res.text()
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(Number(row.costUsd)).toBeCloseTo(4, 6)
})

test('the catalog is queried once per request, not once for the client and once for the log', async () => {
  const { apiKey, provider } = await seedGateway()
  await seedPrices(provider.id, 'gpt-4o-mini', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })
  const priceFor = vi.spyOn(pricing, 'priceFor')

  await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  expect(priceFor).toHaveBeenCalledTimes(1)
})
```

The file already imports `* as pricing from '@/lib/pricing'`.

- [ ] **Step 1b: Rewrite the test this task's premise invalidates**

`tests/gateway/request-logging.test.ts` already has a test named **`a pricing
failure never reaches the client`** (around line 262). It makes `priceFor`
reject and then proves two things: the client still gets a 200, and — via its
comment — that the fire-and-forget `.catch()` at the `log()` call site really
catches a throw from an await *inside* async `writeLog`, not just one from
`logRequest`.

Step 4 of this task deletes `writeLog`'s `priceFor` call. After that, nothing
throws, no stderr is written, `waitFor(() => stderr.mock.calls.length > 0)`
hangs to the 20s timeout, and `expect(rows).toHaveLength(0)` is false too. The
test fails for the right reason — its premise is gone — but it must not be
merely deleted: it is the only coverage of that catch path.

Replace the whole `a pricing failure never reaches the client` test with these
two. The first asserts the new, correct behaviour; the second re-proves the
catch path using `resolveRequestLogStore`, which `writeLog` still awaits before
it calls `logRequest`:

```ts
test('a pricing failure costs the breakdown, not the request or its log row', async () => {
  const { apiKey } = await seedGateway()
  const failure = vi.spyOn(pricing, 'priceFor').mockRejectedValue(new Error('catalog unreachable'))

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  await waitForLogs()

  // The catalog is no longer in writeLog's path, so a rejection there costs
  // the cost breakdown and nothing else: the client is served, and the row
  // still lands — with a null cost, exactly like an unpriced model.
  expect(res.status).toBe(200)
  expect((await res.json()).usage.cost).toBeNull()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.costUsd).toBeNull()
  failure.mockRestore()
})

test('a throw inside writeLog never reaches the client', async () => {
  const { apiKey } = await seedGateway()
  // What the old pricing-failure test really guarded: the fire-and-forget
  // .catch() at the log() call site catches a rejection from an await inside
  // async writeLog, not merely one from logRequest. priceFor used to be that
  // await; resolveRequestLogStore is the one that remains.
  const failure = vi
    .spyOn(logs, 'resolveRequestLogStore')
    .mockRejectedValue(new Error('settings unreadable'))
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterDeps({ chat: vi.fn().mockResolvedValue(upstreamCompletion) }),
  )
  // No row can land, so wait on the side effect that does happen.
  await waitFor(() => stderr.mock.calls.length > 0)

  expect(res.status).toBe(200)
  expect(stderr).toHaveBeenCalled()
  expect((await postgresStore.query({ limit: 10 })).rows).toHaveLength(0)
  failure.mockRestore()
  stderr.mockRestore()
})
```

Add the namespace import this needs (the file already imports `waitFor`):

```ts
import * as logs from '@/lib/logs'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/gateway/request-logging.test.ts`
Expected: the first three of Step 1's tests PASS already (the log path computes its own cost, which happens to agree); the fourth FAILS with `expected 1, received 2` — that is the duplicate this task removes. If the fourth passes, stop and investigate before changing anything: it means Task 2's lookup did not land.

Step 1b's two tests both FAIL at this point: the first because `writeLog` still recomputes the cost (so the row's `costUsd` is not null), the second because `resolveRequestLogStore` is currently awaited *after* the cost block and the assertion ordering has not yet been proven. Both pass after Step 4.

- [ ] **Step 3: Carry the cost into the log**

In `src/lib/gateway/handler.ts`, add `cost` to the `LogExtra` interface, after `usage`:

```ts
    usage?: LogUsage | null
    /** The cost the client was given, so the log, the client, and the key's
     *  billed spend cannot disagree. Absent on paths that never priced
     *  anything — errors, and streams that ended before usage arrived. */
    cost?: CostBreakdown | null
```

and add `CostBreakdown` to the existing type import from `@/lib/logs/types`:

```ts
import type { CostBreakdown, LogPayload, LogUsage, RequestOutcome } from '@/lib/logs/types'
```

- [ ] **Step 4: Stop recomputing in `writeLog`**

In `writeLog`, replace:

```ts
    const usage = extra.usage ?? null
    const cost =
      extra.candidate && usage
        ? computeCost(
            await priceFor(extra.candidate.provider.id, extra.candidate.upstreamModel),
            usage,
          )
        : null
```

with:

```ts
    const usage = extra.usage ?? null
    // Computed on the response path, not here. Recomputing would issue a
    // second catalog lookup that could straddle a price change or the price
    // cache's TTL, and a client reconciling its own tally against this row
    // would have no guarantee the two came from the same snapshot.
    const cost = extra.cost ?? null
```

`priceFor` is still imported for the response path; `computeCost` likewise. Leave the import line alone.

- [ ] **Step 5: Pass the cost at both call sites**

In the streaming branch's settle callback, add `cost: capture.cost,` after the `usage: capture.usage,` line:

```ts
          log(200, outcome, result.attempts, {
            ...(capture.firstDeltaAt === null ? {} : { ttftMs: capture.firstDeltaAt - startedAt }),
            candidate: result.candidate,
            usage: capture.usage,
            cost: capture.cost,
            error: capture.error ?? undefined,
            response: capturePayloads ? ingress.captureResponse(identity, capture, outcome) : null,
            responseTruncated: capture.truncated,
          }),
```

In the non-streaming branch, add `cost,` after `usage,`:

```ts
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage,
      cost,
      response: completion,
    })
```

The error path's `log(...)` passes neither, which is correct: a request that never reached a provider has no usage and therefore no cost.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gateway/request-logging.test.ts`
Expected: PASS, including the pre-existing `cost is filled in when the catalog prices the winning model` and `an unpriced model logs a null cost rather than zero`.

- [ ] **Step 7: Check the spend counters still bill**

`chargeUsage` reads `cost?.totalUsd` from this same local, so it now bills the client's number.

Run: `pnpm vitest run tests/gateway/limits.test.ts tests/lib/usage`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/gateway/handler.ts tests/gateway/request-logging.test.ts
git commit -m "refactor(gateway): log the cost the client was given instead of recomputing it"
```

---

### Task 5: Document the contract and verify the whole suite

**Files:**
- Modify: `README.md`
- Test: the full suite

**Interfaces:**
- Consumes: everything above. Produces nothing code-facing.

- [ ] **Step 1: Document the response field**

In `README.md`, find this paragraph (around line 183):

```markdown
`x-babellm-provider` and `x-babellm-upstream-model` on the response name who
actually served. Targets can pin a service tier (`flex`, `priority`,
`ultrafast`, …) where the provider supports one.
```

Add a new subsection immediately after it (the outer fence below is four
backticks so the JSON block inside survives — write only the inner content
into the README):

````markdown
### Costs on the response

Every response prices itself. `usage.cost` carries what the request cost, split
the way the gateway billed it:

```json
{
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 340,
    "cost": {
      "currency": "USD",
      "input_usd": "0.003000000",
      "cached_usd": "0.000000000",
      "output_usd": "0.005100000",
      "total_usd": "0.008100000"
    }
  }
}
```

Same field on `/v1/chat/completions` and `/v1/responses`. Streaming puts it on
the final usage chunk (chat) or the `response.completed` event (Responses), so
it arrives with the tokens it prices rather than in a header that has already
been flushed.

Amounts are strings at nine decimal places — a client summing thousands of
requests should not inherit float error from the wire format. Cached tokens are
billed at the cached rate and removed from the input count, so a cache hit is
never charged twice.

`"cost": null` means the request could not be priced: the model has no catalog
entry, or only half of one. It is never `0` — a zero would be indistinguishable
from a free request. When a provider reports no usage at all, there is no
`usage` object and no cost.

The per-million rates behind the numbers stay in the request log and the admin
UI; they are not published to clients.
````

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: PASS. The baseline before this work was 115 files / 1338 tests / 0 failures; this plan adds roughly 25 tests and no file should fail.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors, no new warnings.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document per-request costs on the response"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the wire shape and the "no rates" decision → Task 1; the price prefetch and buffered injection → Task 2; the streaming injection, the TTFT constraint and the `.catch` → Task 3; the log unification and the two-types warning → Task 4; documentation → Task 5. The spec's "Out of scope" list stays out: no currency beyond USD, no opt-out column, no cumulative spend.

**Type consistency.** `costPayload` / `withUsageCost` / `CostPayload` / `attachCost` / `StreamCapture.cost` are spelled identically in every task that references them. The wire type (`CostPayload`) and the internal type (`CostBreakdown`) are named explicitly at each boundary — `finish` and `attachCost` take `CostPayload`; `StreamCapture.cost`, `LogExtra.cost` and the `costFor` callback carry `CostBreakdown`.

**Known ordering constraint.** Task 2 changes the `Ingress.finish` signature, which does not compile until both protocol files are updated — both edits live in Task 2 for that reason. Task 4 depends on both Task 2 and Task 3 having landed; its Step 2 says explicitly what a passing fourth test would mean.
