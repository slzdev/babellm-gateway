# OpenAI-compatible `/v1/embeddings` — Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking. Write the failing test first, then the code,
> then commit.

**Goal:** Serve `POST /v1/embeddings` in the OpenAI shape, routed, priced,
limited, and logged exactly like the two ingresses that already exist.

**Architecture:** A third `Ingress` under the same `runGatewayRequest`, plus one
new adapter method (`embed`). The handler's `Ingress` grows an optional
`streaming` block, so embeddings expresses "no streaming form" by omission
rather than by four unreachable stubs, and a `cost` hook, so a dialect with no
output tokens can be priced on input alone.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, Postgres, Vitest, OpenAI
SDK v7 types, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-09-03-openai-embeddings-endpoint-design.md`
— read section 3 before starting. Every "why" below is recorded there.

## Global Constraints

- **Test database:** `.env.test` points at `babellm_test` on **port 5434**.
  Never repoint it at 5432 — that is the developer's own database. The
  container is already running; do **not** run `pnpm test:db:up` or, under any
  circumstances, `pnpm test:db:down`.
- **Run tests with:** `pnpm test` (full) or `pnpm vitest run <path>` (single
  file). Also `pnpm typecheck` and `pnpm lint` before each commit.
- **Known-failing baseline, not yours:** on `main` as of 2026-09-03, 24 tests
  fail in exactly three files — `tests/lib/stats/aggregate.test.ts` (13),
  `tests/lib/stats/rollup.test.ts` (10) and `tests/lib/stats/state.test.ts`
  (1). All are `insertLog` writing `request_logs` rows dated August 2026 while
  `resetDb` provisions partitions only for the current month and three ahead,
  so Postgres rejects them with `23514` / "Partition key of the failing row".
  The baseline is 1347 passed / 24 failed / 116 files. Any *other* failure is
  yours. Do not fix these; they are out of scope and tracked separately.
- **Money and usage:** `null` means "not measured", never `0`. A measured zero
  is a real value. This is load-bearing in `computeCost` and in the cost
  payload — see the spec's section 3.5.
- **`z.looseObject`** everywhere in the request schema, matching
  `schemas/chat.ts`: unknown parameters pass through to the upstream rather
  than being rejected.
- **Comment the "why", not the "what".** Match the density and voice of the
  surrounding code — the existing modules explain decisions and hazards, never
  restate the statement below them.
- **Commit after every task**, conventional-commit prefixed (`feat:`, `test:`,
  `refactor:`, `docs:`), matching the existing history.

---

### Task 1: A fourth endpoint path, provider-wide and per-model

Nothing embeddings-specific: this makes `/embeddings` configurable the way
`/chat/completions`, `/responses` and `/messages` already are, so the adapter
work in Task 5 has a path to ask for.

**Files:**
- Edit: `src/lib/adapters/paths.ts` — `DEFAULT_PATHS.embeddings = '/embeddings'`,
  `CONFIG_KEYS`, a `PATH_FIELDS` entry, a `MODEL_PATH_FIELDS` entry, and the two
  resolvers' return objects.
- Edit: `src/lib/adapters/types.ts` — `embeddingsPath?: string` on
  `ProviderConfig`; `embeddingsPath?: string | null` on `ModelPathOverrides`.
- Edit: `src/lib/db/schema.ts` — `embeddingsPath: text('embeddings_path')` on
  `catalogModels`, in the "How the gateway reaches this model" block. Update
  that block's comment: it says "all four" of the nullable columns; it is now
  five.
- Create: `drizzle/0011_*.sql` via `pnpm db:generate` (offline; do not
  hand-write the file or the journal entry).
- Edit: `src/lib/adapters/registry.ts` — `withModelPaths` must copy
  `embeddingsPath` and include it in the early-return guard.
- Edit: `src/lib/gateway/resolve.ts` — `modelPaths()` and both candidate
  builders carry the new column.
- Edit: `src/lib/admin/catalog.ts` — the row type, `providerPaths` shape, the
  mapper, and `updateModelGateway`'s patch (mirror `responsesPath` exactly).
- Edit: `src/app/(admin)/catalog/actions.ts` — collect `embeddingsPath` from
  the form.
- Edit: `tests/helpers/gateway.ts` — `TargetSpec.embeddingsPath`, threaded into
  the `catalogModels` insert and its `if (spec.apiFlavor || …)` guard.
- Test: `tests/lib/adapters/paths.test.ts`, `tests/lib/adapters/registry.test.ts`,
  `tests/lib/gateway/resolve.test.ts`, `tests/lib/admin/catalog.test.ts`,
  `tests/lib/db/schema.test.ts` — extend the existing cases rather than adding
  parallel ones.

`src/app/(admin)/catalog/catalog-forms.tsx` and the provider form need no edit:
both render from `MODEL_PATH_FIELDS` / `PATH_FIELDS`. Confirm that by reading
them, and say so in the commit message.

- [ ] **Step 1:** Extend the existing path tests to expect four endpoints —
  including that an unconfigured `embeddings` stays the relative
  `/embeddings` while a configured one resolves against the base URL's origin
  (`resolveRequestPaths`'s two rules, already tested for the other three).
- [ ] **Step 2:** Make them pass across the files above.
- [ ] **Step 3:** `pnpm db:generate`, then read the generated SQL: it must be a
  single `ALTER TABLE … ADD COLUMN "embeddings_path" text;` and nothing else.
  A generated migration that also drops or recreates anything means the schema
  drifted — stop and report rather than committing it.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint`, then commit.

---

### Task 2: The request schema and the wire types

**Files:**
- Create: `src/lib/schemas/embeddings.ts`
- Edit: `src/lib/adapters/types.ts` — re-export the SDK response types beside
  the existing four:
  `export type EmbeddingsResult = OpenAI.Embeddings.CreateEmbeddingResponse`.
- Test: `tests/lib/schemas/embeddings.test.ts`

```ts
export const embeddingsRequestSchema = z.looseObject({
  model: z.string().min(1),
  // All four shapes OpenAI accepts. The token forms are why this is a union
  // rather than `string | string[]`: a client that tokenizes locally sends
  // ids, and only some upstreams can take them (see the Gemini refusal).
  input: z.union([
    z.string(),
    z.array(z.string()).min(1),
    z.array(z.number().int()).min(1),
    z.array(z.array(z.number().int()).min(1)).min(1),
  ]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
})
```

- [ ] **Step 1:** Tests: each of the four `input` shapes parses; an empty
  string is accepted (OpenAI rejects it upstream, and the gateway does not
  duplicate upstream validation — assert this deliberately, with the reason in
  a comment); an empty **array** is rejected; a missing `model` is rejected;
  `dimensions: 0` and `dimensions: -1` are rejected; an unknown parameter
  survives parsing (`looseObject`).
- [ ] **Step 2:** Write the schema. Export `EmbeddingsRequest`.
- [ ] **Step 3:** `pnpm vitest run tests/lib/schemas`, then typecheck, lint,
  commit.

---

### Task 3: `Ingress.streaming` becomes optional — a pure refactor

No behaviour changes. The existing suite is the test.

**Files:**
- Edit: `src/lib/gateway/handler.ts` — group `isStream`, `runStream`, `stream`
  (renamed `protocol` inside the block) and `captureResponse` under an optional
  `streaming` member; default `Chunk` to `never`.
- Edit: `src/lib/gateway/protocols/chat.ts`, `src/lib/gateway/protocols/responses.ts`
  — move those four members into the block.

In `runGatewayRequest`: read `const streaming = ingress.streaming` once, set
`stream = streaming?.isStream(body) ?? false`, and guard the streaming branch on
`if (streaming && stream)` so TypeScript narrows. Inside it, `ingress.stream`
becomes `streaming.protocol` and `ingress.captureResponse` becomes
`streaming.captureResponse`.

Document on the member *why* it is optional (spec 3.1): absence, not a
`false`-returning predicate, is what makes the branch unreachable — a stub that
throws would be untested code that reads as reachable.

- [ ] **Step 1:** Refactor. Touch no test file.
- [ ] **Step 2:** `pnpm test` — the whole suite must be green apart from the
  known-failing baseline. `pnpm typecheck && pnpm lint`.
- [ ] **Step 3:** Commit as `refactor:`.

---

### Task 4: Pricing a request with no output tokens

**Files:**
- Edit: `src/lib/pricing.ts` — add `computeInputOnlyCost`.
- Edit: `src/lib/gateway/usage.ts` — add `usageFromEmbeddings`.
- Edit: `src/lib/gateway/handler.ts` — `Ingress` gains
  `cost(prices, usage): CostBreakdown | null`; both call sites
  (`computeCost(prices, usage)` at the buffered path, and the
  `async (usage) => computeCost(await prices, usage)` closure in the streaming
  branch) call the hook instead.
- Edit: `src/lib/gateway/protocols/chat.ts`, `.../responses.ts` — `cost: computeCost`.
- Test: `tests/lib/pricing.test.ts` (extend), `tests/lib/gateway/usage.test.ts`
  (extend, or create if absent).

`computeInputOnlyCost` requires `inputPerMtok` and `promptTokens`; it prices
cached tokens with `cachedInputPerMtok ?? inputPerMtok` and the same
`Math.min` / subtraction invariant as `computeCost`; `outputUsd` is
`'0.000000000'` — a real zero, because there were no output tokens, not because
none were measured. A missing `outputPerMtok` must **not** make the request
unpriced. Reuse `computeCost`'s `usd()` helper rather than reimplementing the
rounding, and keep `pricing` in the returned breakdown so the log row still
records the rates.

`usageFromEmbeddings` returns
`{ promptTokens, completionTokens: 0, cachedTokens: null, reasoningTokens: null }`
from `{ prompt_tokens, total_tokens }`, and `null` when there is no upstream
usage object at all (Gemini). Note in a comment why `completionTokens` is `0`
and not `null` here when `usageFrom` would leave it `null`: an embeddings
response has no output tokens to measure, so zero is the measurement.

- [ ] **Step 1:** Tests. Include: an embedding model priced with input only and
  a null `outputPerMtok`; a cached-token split; `null` in, `null` out; and that
  `computeCost` is unchanged for chat.
- [ ] **Step 2:** Implement, thread the `cost` hook through the handler.
- [ ] **Step 3:** `pnpm test && pnpm typecheck && pnpm lint`, commit.

---

### Task 5: `embed` on the OpenAI-shaped adapters

**Files:**
- Edit: `src/lib/adapters/types.ts` — `embed?(req: EmbeddingsRequest, ctx: AttemptContext): Promise<EmbeddingsResult>`
  on `ProviderAdapter`, documented as optional-by-necessity (spec 3.2: no
  wrapper can synthesize an embedding from a chat completion) and excluded from
  `ChatOnlyAdapter`'s `Omit` list only if the types demand it — read the file
  and keep `ChatOnlyAdapter` meaning what it means today.
- Create: `src/lib/adapters/openai/embeddings.ts` — the shared implementation
  both OpenAI-dialect entry points call.
- Edit: `src/lib/adapters/openai/index.ts` and
  `src/lib/adapters/openai/responses.ts` — wire it in. A `responses`-flavored
  model embeds through the same client; flavor selects the chat dialect only.
- Edit: `src/lib/adapters/wrappers.ts` — `withRespondViaChat` spreads
  `...adapter`, so an `embed` on the wrapped adapter already survives. Verify
  and comment; change nothing if it does.
- Test: `tests/lib/adapters/openai/embeddings.test.ts`,
  and one case in `tests/lib/adapters/openai/custom-paths.test.ts`.

The implementation, per spec 3.3 — **the explicit `encoding_format` is not
optional**:

```ts
// The SDK rewrites this parameter when the caller omits it: it sends base64
// upstream and decodes the reply into a Float32Array, which JSON.stringify
// renders as {"0":0.1,…} — an object no OpenAI client can read as an
// embedding. Sending it explicitly is what makes the SDK pass the upstream
// body through untouched. See openai/resources/embeddings.mjs.
encoding_format: req.encoding_format ?? 'float',
```

Errors go through the existing `toProviderError(err, FLAVOR_HINT)`.

- [ ] **Step 1:** Tests against a fake `OpenAIClientFactory` (copy the harness
  from `tests/lib/adapters/openai/chat.test.ts`): the upstream body carries
  `model: ctx.upstreamModel`, an explicit `encoding_format: 'float'` when the
  client sent none, and `'base64'` when it did; the request reaches
  `paths.embeddings`, including a configured override; a 429 classifies
  retryable and a 400 does not.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm test && pnpm typecheck && pnpm lint`, commit.

---

### Task 6: Gemini — `embedContent`, translated

**Files:**
- Create: `src/lib/translate/embeddings-to-gemini.ts` — pure, no client:
  `toEmbedParams`, `fromEmbedContent`, `droppedParams`, and the base64 encoder.
- Edit: `src/lib/adapters/gemini/index.ts` — `embed`, thin over the translator,
  wrapping failures in `toProviderError`.
- Test: `tests/lib/translate/embeddings-to-gemini.test.ts`,
  `tests/lib/adapters/gemini/embeddings.test.ts`.

Per spec 3.4:
- `input` string → `contents: [input]`; `string[]` → `contents: input`.
- Token-array input (`number[]` or `number[][]`) → throw a **non-retryable 400**
  `ProviderError` (`unsupported_input`), naming the provider. Model this on
  `assertServiceable` in `responses-to-chat.ts`; a request whose answer would be
  about different content than the client asked about is refused, not served.
- `dimensions` → `config.outputDimensionality`; `ctx.signal` →
  `config.abortSignal`.
- `encoding_format: 'base64'` → encode each vector as little-endian float32,
  base64 — the same bytes OpenAI returns. Test it round-trips through
  `Buffer.from(str, 'base64')` + `Float32Array` back to the input floats
  (float32 precision: compare with `toBeCloseTo`, and say why in a comment).
- `user` → `droppedParams` reports it.
- Response: `embeddings[i].values` → `{ object: 'embedding', index: i, embedding }`,
  order preserved, `object: 'list'`, `model: ctx.upstreamModel`. **No `usage`
  key at all** — the Developer API measures nothing here, and a fabricated
  `usage` would claim a measurement that never happened. A missing or empty
  `embeddings` array is an upstream failure: throw, don't return an empty list.

- [ ] **Step 1:** Translator tests, both directions, including the refusal and
  the base64 encoding.
- [ ] **Step 2:** Implement the translator, then the adapter method against a
  fake `GeminiClientFactory` (harness in `tests/lib/adapters/gemini/chat.test.ts`).
- [ ] **Step 3:** `pnpm test && pnpm typecheck && pnpm lint`, commit.

---

### Task 7: The ingress and the route

**Files:**
- Create: `src/lib/gateway/protocols/embeddings.ts`
- Create: `src/lib/gateway/embeddings-handler.ts` (mirrors
  `responses-handler.ts` — five lines)
- Create: `src/app/v1/embeddings/route.ts` (mirrors
  `src/app/v1/chat/completions/route.ts`)
- Edit: `src/lib/gateway/protocols/dropped.ts` — add `droppedForEmbeddings`
  beside `droppedForChat`, or export the Gemini translator's `droppedParams`
  through it; keep the "one function answers this question" property that
  file's comment describes.
- Test: `tests/lib/gateway/protocols/embeddings.test.ts` (unit, if the ingress
  has logic worth isolating — otherwise rely on Task 8).

The ingress:
- `parse` → `parseWith(embeddingsRequestSchema, raw)`
- `modelOf` → `req.model`
- `streaming` → **absent**
- `run` → refuse when `adapter.embed` is undefined, with an
  `UnsupportedOperationError` naming the provider and its flavor and pointing at
  the Catalog page (spec 3.2). This is the only place that refusal lives.
- `droppedFor` → Gemini's dropped set; `[]` for the OpenAI-shaped adapters,
  which are sent the request as it arrived.
- `finish` → `withUsageCost(rewriteModel(res, identity), cost)`. The `model` is
  rewritten to the virtual name; there is **no id** on an embeddings response,
  so `newIdentityId` returns an id that is used only as the log's identity —
  read `identity.ts` and pick the honest option: reuse `newCompletionId` only if
  nothing ships it to the client, and comment on it the way
  `protocols/responses.ts`'s `captureResponse` comments on its absent id.
- `usageOf` → `usageFromEmbeddings(res.usage)`
- `cost` → `computeInputOnlyCost`

- [ ] **Step 1:** Implement ingress, handler, route.
- [ ] **Step 2:** `pnpm test && pnpm typecheck && pnpm lint`, commit.

---

### Task 8: End-to-end gateway tests

**Files:**
- Create: `tests/gateway/embeddings.test.ts`
- Edit: `tests/helpers/gateway.ts` — an `embeddingsRequest(body, apiKey, headers)`
  builder beside `chatRequest`/`responsesRequest`, and `embed` in both fake
  adapter factories' default-throw sets.

Model the file on `tests/gateway/chat.test.ts`. Cover:

- [ ] A happy path: two inputs in, two vectors out, in order; `model` rewritten
      to the virtual name; `x-babellm-provider` and `x-babellm-upstream-model`
      headers; `usage.cost` present and matching the catalog rates.
- [ ] `401` with no key, `401` with a bad key.
- [ ] `404` for an unknown model; `503` for a virtual model with no enabled
      targets.
- [ ] `429` from a key over its rpm limit, with the rate-limit headers — and no
      log row written (the deliberate omission in `handler.ts`'s catch).
- [ ] Failover: first target throws a retryable 429, second serves; the log's
      attempt chain has both, and `final` names the second.
- [ ] `501 unsupported_operation` when the adapter has no `embed`, and that it
      does **not** fail over to a healthy sibling (spec 3.7).
- [ ] The log row: `stream = false`, `prompt_tokens`, `completion_tokens = 0`,
      the cost columns, `x-babellm-tags` on the row, and `dropped_params` when a
      Gemini target dropped `user`.
- [ ] Payload capture on a key with `logPayloads`: request and response stored,
      and `truncated` set when the vectors exceed `payloadMaxBytes` (set a small
      cap in the settings row rather than generating megabytes of floats).
- [ ] A `base64` request passes the encoding through rather than decoding it.

Run the new file alone first, then the full suite.

- [ ] Commit as `test:`.

---

### Task 9: Documentation and final verification

**Files:**
- Edit: `README.md` — document the endpoint where `/v1/responses` is
  documented; remove `/v1/embeddings` from the Status section's gap list
  (leaving the Bedrock and `/v1/models` gaps); add the `embeddings_path` field
  to wherever the other three paths are described; note that Gemini embeddings
  report no usage and are therefore unpriced, and that an Anthropic-flavored
  target answers 501.
- Edit: the mermaid diagram's gateway node — it lists the served endpoints.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Full verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
      and `pnpm build`. Confirm the only failures are the known-failing
      baseline named in Global Constraints.
- [ ] **Step 3:** Commit as `docs:`.

---

## Definition of done

- `POST /v1/embeddings` serves an OpenAI-shaped request through the same
  routing, limits, breaker, failover, logging and cost path as the other two
  ingresses, against `openai`, `openai_compatible` and `gemini` providers.
- An Anthropic-flavored target answers a non-retryable 501; a token-array input
  on a Gemini target answers 400.
- `embeddings_path` is configurable per provider and per model.
- One additive migration; no existing row's meaning changed.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` all clean apart
  from the pre-existing August-partition failures.
