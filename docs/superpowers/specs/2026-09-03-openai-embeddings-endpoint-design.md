# Embeddings API (OpenAI-compatible) — design

The gateway serves `/v1/chat/completions` and `/v1/responses`. This phase adds
`POST /v1/embeddings` as a third ingress, and `embed` as the egress that answers
it — natively on the OpenAI-shaped adapters, translated on Gemini.

## 1. Problem

Embeddings are the other half of every retrieval application, and today they are
the one thing a client cannot point at the gateway. `README.md` records this as
a known gap: "No Bedrock adapter, no `/v1/models`, no `/v1/embeddings`."

The consequence is not a missing endpoint but a split configuration. A team that
routes its chat traffic through the gateway — budgets, per-key limits, request
logs, failover, cost attribution — still has to hand its embedding calls a raw
provider key and a second base URL. Every guarantee this gateway exists to
provide (one key, one model name, one log, one bill) stops at the boundary of
the retrieval pipeline, which for a RAG application is most of its traffic by
request count.

Nothing about embeddings needs new gateway machinery. Routing, breakers,
failover, limits, logging, and pricing are all shape-independent and already
live in `runGatewayRequest`. What is missing is a third `Ingress` and one more
adapter method.

## 2. Scope

In scope:

- `POST /v1/embeddings`, request and response in the OpenAI shape.
- `embed` on `ProviderAdapter`, native for `openai` / `openai_compatible`
  (under either OpenAI-dialect flavor), translated for `gemini`, refused for
  `anthropic_messages`.
- `src/lib/schemas/embeddings.ts` and `src/lib/translate/embeddings-to-gemini.ts`
  — both new.
- An optional `streaming` block on `Ingress`, so a dialect with no streaming
  form is expressed by its absence rather than by four stub members.
- `embeddings_path`, configurable per provider and per model, matching the
  three paths that already are.
- Cost for a request that has input tokens and no output tokens.

Out of scope, each by explicit decision:

- **Streaming.** The OpenAI embeddings API has no streaming form. `stream` is
  not a documented parameter; a client that sends one gets it forwarded to an
  OpenAI-shaped upstream that ignores it, exactly as today's unknown parameters
  are forwarded. Section 3.1.
- **`/v1/models`.** Still unserved, and orthogonal.
- **Multimodal embeddings.** Gemini's image and video embedding endpoints have
  no OpenAI-dialect expression; `input` stays text (or tokens). Section 3.4.
- **Batching across targets.** One request is served by one target. A 2048-input
  request is not split across providers.
- **A gateway-side embedding cache.** Cheap to add later, and a different
  feature — it needs an eviction policy, a keying decision, and a storage
  budget, none of which this endpoint should decide.
- **Enforcing `catalog_models.kind = 'embedding'`.** Section 3.8.

**One migration**, additive: a nullable `embeddings_path` column on
`catalog_models`. No backfill, and a rollback loses only per-model overrides
nobody could have set before this ships.

## 3. Decisions

| Decision | Choice |
|---|---|
| Third ingress or new handler | Third `Ingress`, same `runGatewayRequest`. Section 3.1. |
| Non-streaming shape | `Ingress.streaming` becomes optional; absence means "no streaming form". Section 3.1. |
| Egress method | `embed` on `ProviderAdapter`, optional, refused where absent. Section 3.2. |
| `encoding_format` | Always sent explicitly upstream, defaulting to `float`. Section 3.3. |
| Gemini | Translated via `embedContent`; token-array input refused. Section 3.4. |
| Pricing | Input-only, via an ingress-supplied cost function. Section 3.5. |
| Path overrides | Provider and per-model, like the other three. Section 3.6. |
| A target that cannot embed | Non-retryable 501, no failover. Section 3.7. |
| Model kind | Not enforced. Section 3.8. |
| Payload capture | Unchanged, and capped as today. Section 3.9. |
| A target's pinned `service_tier` | Not injected on this endpoint. Section 3.10. |

### 3.1 A third ingress, and what "no streaming" costs the interface

`runGatewayRequest` already carries everything embeddings needs and nothing it
does not: it authenticates, tags, checks limits, resolves the model, walks the
breaker-filtered chain, prices the result, attaches the cost, and logs. The
shape-specific half lives behind `Ingress` (`src/lib/gateway/handler.ts:44`),
which is 11 members — of which four exist only for streaming: `isStream`,
`runStream`, `stream`, and `captureResponse`.

Embeddings has no streaming form. Three ways to express that:

1. **Stub the four members** — `isStream: () => false` and three throws. The
   throws are unreachable, so they are untested code that reads as reachable,
   and a future refactor that calls `runStream` unconditionally would find no
   type error to stop it.
2. **A second handler** for non-streaming ingresses. Duplicates the lifecycle,
   which is precisely what `Ingress` was extracted to prevent.
3. **Group the four behind one optional member.** Chosen.

```ts
export interface Ingress<Req, Res, Chunk = never> {
  parse(raw: unknown): Req
  modelOf(req: Req): string
  droppedFor(candidate: Candidate, req: Req): string[]
  run(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): Promise<Res>
  finish(res: Res, identity: IdentityOptions, cost: CostPayload | null): Res
  usageOf(res: Res): LogUsage | null
  newIdentityId(): string
  /** Absent for a dialect with no streaming form. Its absence, not a
   *  `false`-returning predicate, is what makes the streaming branch of the
   *  handler unreachable for such an ingress. */
  streaming?: {
    isStream(req: Req): boolean
    runStream(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): AsyncIterable<Chunk>
    protocol: StreamProtocol<Chunk>
    captureResponse(identity: IdentityOptions, capture: StreamCapture, outcome: StreamOutcome): unknown
  }
}
```

The handler reads `const streaming = ingress.streaming` once and branches on
`streaming?.isStream(body) ?? false`, which is also what the log row's `stream`
column records. Chat and Responses move their four members into the block; no
behaviour changes, and the refactor is verified by the existing suite rather
than by new tests.

### 3.2 `embed` is optional on the adapter, and refusal is the adapter's job

`respond` is *required* on `ProviderAdapter` because every adapter can serve a
Responses request — `withRespondViaChat` supplies it for the chat-only ones. No
such wrapper exists for embeddings: you cannot synthesize an embedding from a
chat completion. Anthropic's API has no embeddings endpoint at all, and a clone
serving the Anthropic Messages shape is no more likely to have one.

So `embed?` is optional, and the embeddings ingress's `run` refuses when it is
absent:

```ts
run: (adapter, ctx, req) => {
  if (!adapter.embed) throw new UnsupportedOperationError(...)
  return adapter.embed(req, ctx)
}
```

`classifyProviderError` already maps `UnsupportedOperationError` to a
non-retryable 501 `unsupported_operation` (`src/lib/gateway/errors.ts:89`), so
this needs no new error plumbing. The message names the provider and its flavor,
because the actionable fix is on the Catalog page.

Which adapters get it:

| Adapter / flavor | `embed` |
|---|---|
| `openai`, `openai_compatible` — `chat_completions` flavor | Native. `client.embeddings.create` on the resolved path. |
| `openai`, `openai_compatible` — `responses` flavor | Native, the same way. A model answering the Responses API is still reached through the same OpenAI client, and `/embeddings` is a sibling endpoint, not a dialect. |
| `gemini` | Translated. Section 3.4. |
| `anthropic_messages` flavor | Absent. 501. |
| `bedrock` | Absent — the whole adapter is still 501. |

The `responses` row is the one worth stating out loud: flavor selects the
*chat* dialect, and embeddings are outside that choice. Both OpenAI-shaped
adapters therefore implement `embed` identically, which is why it lives in a
shared module (`src/lib/adapters/openai/embeddings.ts`) that both entry points
call rather than being written twice.

### 3.3 `encoding_format` is always sent, and this is not a style choice

The OpenAI Node SDK rewrites this parameter. `embeddings.create` (v7,
`node_modules/openai/resources/embeddings.mjs`) checks whether the caller set
`encoding_format`; if not, it sends `base64` upstream for performance and
decodes the response into a **`Float32Array`**.

That is fatal for a gateway. `JSON.stringify(new Float32Array([0.1, 0.2]))`
produces `{"0":0.1,"1":0.2}` — an object, not an array — so a client that
omitted `encoding_format` (the common case, and OpenAI's documented default of
`float`) would receive a response no OpenAI SDK can parse.

The adapter therefore always sends an explicit `encoding_format`: the client's
value when it sent one, `'float'` otherwise. With the parameter explicitly set,
the SDK returns the upstream body verbatim, which is exactly what a gateway
must do. A client asking for `base64` gets base64 strings through untouched.

This is recorded as a decision rather than a line of code because it looks
removable. It is not, and the test that guards it asserts the parameter reaches
the client factory even when the client's request omitted it.

### 3.4 Gemini

`embedContent` takes `contents` (one string or many) and returns
`embeddings: [{ values: number[] }]` in request order. The mapping:

| OpenAI | Gemini | Note |
|---|---|---|
| `input: string` | `contents: [string]` | One embedding out. |
| `input: string[]` | `contents: string[]` | Order preserved; `index` is the array position. |
| `input: number[] \| number[][]` | — | **Refused**, 400. Section below. |
| `dimensions` | `config.outputDimensionality` | Direct. |
| `encoding_format: 'base64'` | — | Encoded gateway-side: little-endian float32, base64. The same bytes OpenAI returns. |
| `user` | — | Dropped, and reported in `x-babellm-dropped-params`. |
| — | `usage` | Absent. The Developer API reports no token counts for `embedContent` (`statistics` and `metadata.billableCharacterCount` are Vertex/GEAP-only), so the response carries no `usage` and the request is unpriced. |

**Token-array input is refused, not dropped.** `input` may be an array of token
ids, which Gemini cannot accept — it embeds text. Silently re-interpreting token
ids as anything else would return vectors for content the client never asked
about, which is worse than an error. This follows `assertServiceable` in
`responses-to-chat.ts`: a request whose answer would be wrong is refused with a
non-retryable 400, not served lossily. Reported as `invalid_request_error` /
`unsupported_input`, naming the provider.

**No usage means no cost, not a zero cost.** Consistent with the existing
policy: `computeCost` returns null rather than zero when it cannot price
something, and the dashboard renders "unpriced". A Gemini embedding request will
show tokens and cost as unmeasured. Stating it here so it reads as a known
consequence of Google's API rather than a gateway bug.

### 3.5 Pricing an output-less request

`computeCost` refuses to price a request whose `completionTokens` is null, and
refuses again when the catalog has no `output_per_mtok`. Both guards exist for
chat, where half a price is not a price.

An embeddings response reports `prompt_tokens` and `total_tokens` and nothing
else. There are no output tokens to measure — not "unmeasured", genuinely none.
So:

- `usageOf` normalizes upstream usage into `LogUsage` with
  `completionTokens: 0`. A measured zero, which the existing `computeCost`
  comment explicitly admits as legitimate.
- Pricing goes through a new sibling, `computeInputOnlyCost(prices, usage)`,
  which requires `inputPerMtok` and treats a missing `outputPerMtok` as
  inapplicable rather than as a missing price. An embedding model whose catalog
  row has an input rate and no output rate is fully priceable, and today's
  `computeCost` would call it unpriced.

`Ingress` gains a `cost` member so the handler stops hardcoding `computeCost`:

```ts
/** How this dialect turns catalog rates into a charge. Chat and Responses
 *  bill input and output; embeddings has no output to bill. */
cost(prices: PricingSnapshot | null, usage: LogUsage | null): CostBreakdown | null
```

Chat and Responses pass `computeCost`; embeddings passes
`computeInputOnlyCost`. The handler's two call sites (buffered, and the
streaming closure) both read the hook, so the client's number, the log row, and
the key's billed spend stay one value — the invariant the cost-metadata phase
established.

### 3.6 Path overrides, all four endpoints

`embeddings` joins `DEFAULT_PATHS` as `/embeddings`, `PATH_FIELDS` (provider
form), `MODEL_PATH_FIELDS` (catalog dialog), and `ModelPathOverrides`. The
per-model half needs the migration in section 2.

Full symmetry rather than provider-level only, because the reason per-model
paths exist applies here unchanged: an aggregator that serves several upstreams
behind one base URL hangs each on its own prefix, and the model is what knows
which. Adding three of four now and the fourth later means touching the same
eight files twice.

`resolveRequestPaths` needs no new logic — its rules (a configured path is
absolute on the base URL's origin; an unconfigured one stays relative) are
per-endpoint already.

### 3.7 A target that cannot embed does not fail over

`UnsupportedOperationError` classifies as non-retryable, so a chain whose first
target is Anthropic-flavored fails the request with 501 rather than trying the
second target.

This is deliberate. A virtual model's targets are meant to be interchangeable;
one that cannot serve the operation at all is a configuration error, and failing
over would hide it behind a working sibling until the day that sibling is down.
The 501 names the provider and says where to fix it. (Contrast the
`createAdapter` throw path in `execute.ts:154`, which *does* skip to the next
target — that one covers a provider the gateway cannot construct at all, where
the chain is the only evidence available.)

The breaker is untouched by this: `recordHealth` only sees retryable failures.

### 3.8 `kind` is not enforced

`catalog_models.kind` already distinguishes `'embedding'` from `'chat'`, and the
temptation is to reject a chat model on this endpoint.

Not done. `kind` is inferred — from models.dev, from Gemini's
`supportedActions`, and failing both from a regex on the model id
(`merge.ts:23`). A heuristic that decides whether a request is *allowed* turns a
metadata guess into an outage: a correctly configured embedding model whose id
does not contain "embed" would be refused. The upstream knows what it can embed
and says so; its 400 is more accurate than the gateway's guess.

### 3.9 Logging and payload capture

Nothing new. The log row records `stream = false`, the usage above, the cost
from section 3.5, tags, dropped params, and the attempt chain, exactly as the
other two ingresses do.

Payload capture is per-key and off by default, and stays bounded by
`payloadMaxBytes` via `capPayload`. An embeddings response is unusually large
for its token count — a 3072-dimension vector is ~40KB of JSON — so a key with
capture enabled will see truncated responses more often here than on chat. That
is the existing cap doing its job, and the `truncated` flag already says so.

### 3.10 A pinned service tier is not injected here

`bodyFor` in the handler overwrites `service_tier` with whatever the winning
target pins, and both chat dialects carry that parameter at the top level. The
embeddings dialect does not have it at all.

The tempting reading is that this makes a pinned tier *inert* on this endpoint —
an OpenAI-shaped upstream ignoring an undocumented parameter the way it ignores
any other. That reading is wrong: OpenAI answers an argument it does not
recognise with `400 Unrecognized request argument supplied`, and a 400 is
non-retryable, so it does not fail over. An operator who pins `flex` on a target
that also serves an embedding model would take every embeddings request to that
target off the air, with an error blaming an argument they never sent.

So `Ingress` carries `pinsServiceTier`, and the embeddings ingress sets it
`false`: the injection is declined at the one place that knows which dialect is
being spoken. A tier a *client* sends itself is still forwarded untouched, on
this endpoint as on any other — the schema is loose, and what the caller sends
is the caller's to answer for. On a Gemini target such a client-sent tier is
reported in `x-babellm-dropped-params` under the ordinary drop-and-report rule.

## 4. Wire contract

Request, as OpenAI's:

```http
POST /v1/embeddings
Authorization: Bearer sk-bab-…

{ "model": "house-embed", "input": ["hello", "world"],
  "encoding_format": "float", "dimensions": 512 }
```

Response, as OpenAI's, plus the gateway's `usage.cost` (the same field chat and
responses carry since `c3f6b26`):

```json
{
  "object": "list",
  "model": "house-embed",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.01, -0.02] },
    { "object": "embedding", "index": 1, "embedding": [0.03, -0.04] }
  ],
  "usage": {
    "prompt_tokens": 4,
    "total_tokens": 4,
    "cost": { "currency": "USD", "input": "0.000000080", "cached": "0.000000000",
              "output": "0.000000000", "total": "0.000000080" }
  }
}
```

`model` is rewritten to the name the client asked for, like chat's. Response
headers are the gateway's usual set: `x-request-id`, `x-babellm-provider`,
`x-babellm-upstream-model`, `x-babellm-dropped-params` when anything was
dropped, and the rate-limit headers.

Errors reuse the existing envelope. The two new ones:

| Status | Code | When |
|---|---|---|
| 501 | `unsupported_operation` | The target's adapter cannot embed (section 3.2). |
| 400 | `unsupported_input` | Token-array `input` on a Gemini target (section 3.4). |

## 5. Testing

- **Unit, pure:** the schema; `embeddings-to-gemini.ts` both directions,
  including base64 encoding, `outputDimensionality`, order preservation, and the
  token-array refusal; `computeInputOnlyCost`; `paths.ts` with four endpoints.
- **Unit, adapter:** `embed` on the OpenAI adapters against a fake client
  factory — asserting the explicit `encoding_format` of section 3.3, the
  resolved path, and error classification; the same for Gemini against a fake
  `GoogleGenAI`.
- **End-to-end, gateway:** `tests/gateway/embeddings.test.ts` against a fake
  adapter — auth, limits, model resolution, failover across two targets, the
  501 and 400 refusals, the log row, `usage.cost`, tags, dropped params, and
  payload capture.
- **Regression:** the existing suite covers the `Ingress` refactor of section
  3.1. It must stay green with no test edits beyond the mechanical move of the
  four members.

## 6. Rollout

Additive in every direction. A client that never calls `/v1/embeddings` sees no
change; the endpoint 404s today, so there is no behaviour to preserve. The
migration adds one nullable column.

Rollback is `git revert` plus dropping the column. No data is rewritten, and no
existing row's meaning changes.
