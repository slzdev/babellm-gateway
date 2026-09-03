# Embeddings API (OpenAI-compatible) — design

The gateway serves `/v1/chat/completions`, `/v1/responses` and
`/v1/audio/transcriptions`. This phase adds `POST /v1/embeddings` as a fourth
ingress, and `embed` as the egress that answers it — natively on the
OpenAI-shaped adapters, translated on Gemini.

> **Reconciled onto `2fc5274`.** This document was written against `c3f6b26`,
> before `/v1/audio/transcriptions` shipped and widened the same `Ingress`
> seam. Where the two designs answered the same question differently, the
> transcription one won — it is the shipped seam, and embeddings is the same
> *kind* of dialect (no streaming, no response id), so the two should look
> alike. Adopted from it: `read`/`toResponse` instead of `parse`; individually
> optional streaming members plus `assertStreamable` instead of a grouped
> `streaming` block (§3.1); an *optional* `bodyFor` instead of a
> `pinsServiceTier` flag (§3.10); a **required** `embed` supplied for the one
> flavor that cannot by a `withEmbedUnsupported` wrapper, instead of an
> optional `embed` refused by the ingress (§3.2); and `supports` filtering the
> candidate chain before selection, which reverses this document's original
> no-failover decision into steering (§3.7). Kept from this document, because
> the shipped seam has no equivalent: `Ingress.cost`, which input-only pricing
> needs (§3.5). The migration is renumbered `0012`; transcriptions took
> `0011`.

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
live in `runGatewayRequest`. What is missing is a fourth `Ingress` and one more
adapter method.

## 2. Scope

In scope:

- `POST /v1/embeddings`, request and response in the OpenAI shape.
- `embed` on `ProviderAdapter`, native for `openai` / `openai_compatible`
  (under either OpenAI-dialect flavor), translated for `gemini`, refused for
  `anthropic_messages`.
- `src/lib/schemas/embeddings.ts` and `src/lib/translate/embeddings-to-gemini.ts`
  — both new.
- One additive seam on `Ingress`: `cost`, so the handler stops hardcoding
  `computeCost`. Every other seam this endpoint needs already exists, having
  been added for transcriptions.
- `embeddings_path`, configurable per provider and per model, matching the
  four paths that already are.
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
`catalog_models`, numbered `0012` (`0011` is transcriptions'). No backfill, and
a rollback loses only per-model overrides nobody could have set before this
ships.

## 3. Decisions

| Decision | Choice |
|---|---|
| Third ingress or new handler | Third `Ingress`, same `runGatewayRequest`. Section 3.1. |
| Non-streaming shape | The streaming members stay individually optional, as transcriptions made them; this ingress declares none. Section 3.1. |
| Egress method | `embed` required on `ProviderAdapter`, supplied by `withEmbedUnsupported` where impossible. Section 3.2. |
| `encoding_format` | Always sent explicitly upstream, defaulting to `float`. Section 3.3. |
| Gemini | Translated via `embedContent`; token-array input refused. Section 3.4. |
| Pricing | Input-only, via an ingress-supplied cost function. Section 3.5. |
| Path overrides | Provider and per-model, like the other four. Section 3.6. |
| A target that cannot embed | Filtered out of the chain by `supports`; the 501 is the all-ineligible fallback. Section 3.7. |
| Model kind | Not enforced. Section 3.8. |
| Payload capture | Unchanged, and capped as today. Section 3.9. |
| A target's pinned `service_tier` | Not injected — no `bodyFor` — and reported as dropped. Section 3.10. |

### 3.1 A fourth ingress, and what "no streaming" costs the interface

`runGatewayRequest` already carries everything embeddings needs and nothing it
does not: it authenticates, tags, checks limits, resolves the model, walks the
breaker-filtered chain, prices the result, attaches the cost, and logs. The
shape-specific half lives behind `Ingress`, which transcriptions already split
into a required core and an optional remainder — precisely so a dialect that is
not JSON, cannot stream, or mints no response id can say so by omission instead
of by a stub that throws or lies.

Embeddings needs three of those omissions and one addition, and nothing else.
What it omits:

- **`runStream`, `stream`, `captureResponse`.** The OpenAI embeddings API has
  no streaming form. Their absence, not a `false`-returning predicate, is what
  makes the handler's streaming branch unreachable for this ingress;
  `assertStreamable` turns a dialect that got `isStream` wrong into a thrown
  error rather than a crash inside the SSE relay.
- **`newIdentityId`.** An embeddings response has no `id` field, so there is
  nothing to mint one for. The handler passes `''`, which nothing reads.
  Section 3.9's earlier claim — that an unused id had to be minted anyway
  because one `IdentityOptions` serves every ingress — no longer holds: the
  member is optional, so the absence is now expressible honestly.
- **`bodyFor`.** Section 3.10.

`isStream` is still implemented, as `() => false`. Unlike transcription, whose
schema refuses `stream: true` with a 400, this ingress lets one through: the
endpoint documents no such parameter, so one a client sends is forwarded like
any other unknown field and ignored by an OpenAI-shaped upstream. What the
`() => false` guarantees is that it can never route the request into the
streaming branch, and that the log row's `stream` column records false.

**The original design here was different, and was dropped.** It grouped the
four streaming members behind one optional `streaming` block, on the grounds
that they always arrive together. Transcriptions shipped them individually
optional plus an `assertStreamable` narrowing guard instead. Both express "this
dialect cannot stream"; the shipped one wins on two counts. It needs no
migration of Chat and Responses into a nested object, and its guard converts
the one remaining hole — an ingress whose `isStream` returns true with no
implementation behind it — into an error naming the inconsistency, which a
grouped block makes unrepresentable in the type system but silent if the
handler ever reads `isStream` from outside the block. The grouped version's
real advantage, that `runStream` cannot be called without `protocol`, is worth
less than not having two ways to spell the same thing in one interface.

The one member this endpoint *adds* is `cost` (section 3.5), which is the only
place the shipped seam has no equivalent: the handler still hardcodes
`computeCost` at both pricing sites, and an output-less dialect cannot be
priced by that rule.

### 3.2 `embed` is required on the adapter, and the refusal is a wrapper's

`respond` is *required* on `ProviderAdapter` because every adapter can serve a
Responses request — `withRespondViaChat` supplies it for the chat-only ones. No
such wrapper can exist for embeddings in that sense: you cannot synthesize a
vector from a chat completion. Anthropic's API has no embeddings endpoint at
all, and a clone serving the Anthropic Messages shape is no more likely to have
one.

The original reading of that was that `embed` should therefore be *optional*,
with the ingress turning the absence into a 501. Transcriptions had the same
gap for the same reason and answered it the other way: `transcribe` is
required, and `withTranscribeUnsupported` supplies the one implementation that
throws. Embeddings follows it, with a `withEmbedUnsupported` twin:

```ts
export function withEmbedUnsupported<A extends ChatOnlyAdapter>(
  adapter: A, providerName: string, reason: string,
): A & Pick<ProviderAdapter, 'embed'> {
  return {
    ...adapter,
    async embed(): Promise<EmbeddingsResult> {
      throw new UnsupportedOperationError(
        `"${providerName}" cannot serve embeddings: ${reason}.`,
      )
    },
  }
}
```

applied in `registry.ts` to the `anthropic_messages` branch only, outside
`withTranscribeUnsupported` so both refusals survive.

Three reasons this is better than the optional member, beyond symmetry:

1. **Capability stops being a fact only the ingress can see.** `supports`
   (section 3.7) has to judge the same question *before* target selection, and
   an optional method would have made "can this candidate embed" a property
   readable in two places — the ingress's `run` and the ingress's `supports` —
   with the adapter, which actually knows, in neither.
2. **A direct unit call behaves.** With an optional member, calling `embed` on
   an Anthropic-flavored adapter is `undefined is not a function`; with the
   wrapper it is the same 501 the gateway would answer.
3. **The type stops lying about `ChatOnlyAdapter`.** `embed` joins `respond`,
   `respondStream` and `transcribe` in what that alias omits, so
   `createOpenAIAdapter` and `createGeminiAdapter` declare the natives they
   really do supply and the compiler checks that `createAdapter` returns a
   whole `ProviderAdapter` on every branch.

`classifyProviderError` already maps `UnsupportedOperationError` to a
non-retryable 501 `unsupported_operation` (`src/lib/gateway/errors.ts:89`), so
this needs no new error plumbing. The `reason` names why the provider cannot
serve, because the actionable fix is on the Catalog page.

Which adapters get it:

| Adapter / flavor | `embed` |
|---|---|
| `openai`, `openai_compatible` — `chat_completions` flavor | Native. `client.embeddings.create` on the resolved path. |
| `openai`, `openai_compatible` — `responses` flavor | Native, the same way. A model answering the Responses API is still reached through the same OpenAI client, and `/embeddings` is a sibling endpoint, not a dialect. |
| `gemini` | Translated. Section 3.4. |
| `anthropic_messages` flavor | `withEmbedUnsupported`. 501. |
| `bedrock` | Never constructed — the whole adapter is still 501. |

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

`Ingress` gains a `cost` member so the handler stops hardcoding `computeCost`.
This is the one seam of this design that survived the reconciliation onto
`2fc5274` unchanged, because the shipped `Ingress` has no equivalent: it still
calls `computeCost` at both pricing sites, which is exactly right for the three
dialects that existed and wrong for the first one with no output to bill.

```ts
/** How this dialect turns catalog rates into a charge. Chat and Responses
 *  bill input and output; a dialect with no output tokens is billed on input
 *  alone. */
cost(prices: PricingSnapshot | null, usage: LogUsage | null): CostBreakdown | null
```

Required rather than optional-with-a-`computeCost`-default, unlike every other
member this endpoint touches: a dialect that says nothing about its own pricing
would then be billed by chat's rules, which is the silent mis-bill the member
exists to prevent. So chat, responses and transcription all pass `computeCost`
explicitly (transcription's usage normalizer has already turned its one
unpriceable variant into null, so it has no output-less case to answer), and
embeddings passes `computeInputOnlyCost`. The handler's two call sites
(buffered, and the streaming closure) both read the hook, so the client's
number, the log row, and the key's billed spend stay one value — the invariant
the cost-metadata phase established.

### 3.6 Path overrides, all five endpoints

`embeddings` joins `DEFAULT_PATHS` as `/embeddings`, `PATH_FIELDS` (provider
form), `MODEL_PATH_FIELDS` (catalog dialog), and `ModelPathOverrides`. The
per-model half needs the migration in section 2 — now numbered `0012`, because
`audio_transcriptions_path` took `0011`.

Full symmetry rather than provider-level only, because the reason per-model
paths exist applies here unchanged: an aggregator that serves several upstreams
behind one base URL hangs each on its own prefix, and the model is what knows
which. Adding four of five now and the fifth later means touching the same
eight files twice.

`resolveRequestPaths` needs no new logic — its rules (a configured path is
absolute on the base URL's origin; an unconfigured one stays relative) are
per-endpoint already.

### 3.7 A target that cannot embed is steered past, not attempted

**This reverses the decision this document originally recorded.** The first
version had `UnsupportedOperationError` classify as non-retryable, so a chain
whose first target was Anthropic-flavored failed the whole request with a 501
rather than trying the second — on the argument that interchangeable targets
are the premise of a virtual model, so one that cannot serve the operation is a
misconfiguration a working sibling would hide.

Transcriptions had the same choice in front of it and made the other one, with
`Ingress.supports`:

```ts
supports?(candidate: Candidate, req: Req): boolean
```

Optional, absent for Chat and Responses (every candidate can serve those), and
used by the handler to filter the candidate list *before* `selectOrder` runs.
Filtering before ordering rather than after is load-bearing: `selectOrder`
truncates to `model.maxAttempts`, so a filter downstream of that truncation
could starve a viable target sitting behind ones this dialect could never have
used.

**The hook steers; it does not refuse.** When it rejects every candidate the
handler orders the *unfiltered* list, so the request reaches an adapter and is
refused by whoever knows why. That is the whole of the reversal, and the
argument that carries it is the one the original decision missed: "a target
that cannot embed" is not one thing. The Anthropic flavor genuinely cannot, for
any request. A Gemini target cannot embed *token ids* and embeds text
perfectly well — so failing a whole model because its first target happens to
be Gemini would refuse a request another target was ready to serve, and
refusing the request the *client* sent depending on which target selection drew
is worse still: a mixed Gemini + OpenAI model under `round_robin` would answer
a token-array request about half the time. Non-deterministic success is not a
behaviour a gateway may have.

The two rules this ingress puts in `supports`, and the refusal each one has
downstream — because **`supports` may never encode a rule the adapter cannot
also refuse**, which is binding on every implementation:

| Rule | Refusal when nothing survives the filter |
|---|---|
| `anthropic_messages` flavor cannot embed | `withEmbedUnsupported`'s 501, naming the provider and the reason (section 3.2). |
| A Gemini target cannot embed token-array `input` | `refuseTokenInput`'s 400 in `embeddings-to-gemini.ts`, naming `input` and both remedies (section 3.4). |

Both are raised before any upstream call, so the fallback costs one recorded
attempt and nothing else. The filter and the token-array refusal read one
predicate, `isTextInput`, exported from the translator — the cheapest way to
keep the invariant true rather than merely intended.

The request being a parameter is what makes the second rule expressible at all:
the token-array shape is knowable from the request alone, which is the test for
what belongs here. A capability only the provider can report — a withdrawn
model, a spent quota — is not, and stays where it is: an attempt, a classified
error, and failover.

The breaker is untouched either way: `recordHealth` only sees retryable
failures, and a steered-past candidate is never attempted at all. (Contrast the
`createAdapter` throw path in `execute.ts:154`, which *does* skip to the next
target — that one covers a provider the gateway cannot construct at all, where
the chain is the only evidence available.)

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
other three ingresses do. `captureRequest` is left unimplemented: the parsed
body *is* what the client sent for a JSON dialect, which is the handler's
default — only transcription, whose request holds an audio `File`, needs to
substitute a description of it.

Payload capture is per-key and off by default, and stays bounded by
`payloadMaxBytes` via `capPayload`. An embeddings response is unusually large
for its token count — a 3072-dimension vector is ~40KB of JSON — so a key with
capture enabled will see truncated responses more often here than on chat. That
is the existing cap doing its job, and the `truncated` flag already says so.

### 3.10 A pinned service tier is not injected here

`bodyFor` rewrites the body per target — both chat dialects pass
`withServiceTier`, which overwrites `service_tier` with whatever the winning
target pins. The embeddings dialect does not have that parameter at all.

The tempting reading is that this makes a pinned tier *inert* on this endpoint —
an OpenAI-shaped upstream ignoring an undocumented parameter the way it ignores
any other. That reading is wrong: OpenAI answers an argument it does not
recognise with `400 Unrecognized request argument supplied`, and a 400 is
non-retryable, so it does not fail over. An operator who pins `flex` on a target
that also serves an embedding model would take every embeddings request to that
target off the air, with an error blaming an argument they never sent.

So this ingress declares **no `bodyFor`**, and the handler's default hands every
candidate the client's own object. The original design expressed the same
decision as a `pinsServiceTier: boolean` on `Ingress`, with `bodyFor` a private
handler function reading it; transcriptions had the identical problem — a tier
would have travelled as an unknown multipart part — and answered it by making
`bodyFor` an optional member instead. That is the better shape, and not only
because it shipped first: a boolean flag says *whether* the one rewrite the
handler knows about applies, where the optional member says *what*, if
anything, this dialect has to say per target. The flag would have had to grow a
sibling for every future per-target rewrite; absence needs nothing.

A tier a *client* sends itself is still forwarded untouched, on this endpoint as
on any other — the schema is loose, and what the caller sends is the caller's to
answer for. On a Gemini target such a client-sent tier is reported in
`x-babellm-dropped-params` under the ordinary drop-and-report rule.

**A pin that lands here is reported rather than silently ignored**, which is the
one thing the original design left out. `droppedForEmbeddings` appends
`service_tier` whenever the winning candidate carries one, on any adapter — the
same clause the transcription ingress carries, and for the same reason: an
operator's routing decision the gateway cannot honour is exactly what that
header exists to surface, and the alternative is inferring it from latency that
never changed. The two halves are de-duplicated, because a request can carry
both a client's tier and an operator's pin and only one parameter did nothing.

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

Errors reuse the existing envelope. The two new ones, both reachable only when
`supports` (section 3.7) found *no* eligible candidate — a model with a viable
sibling is routed to it instead:

| Status | Code | When |
|---|---|---|
| 501 | `unsupported_operation` | Every target is on the `anthropic_messages` flavor (section 3.2). |
| 400 | `unsupported_input` | Token-array `input` and every target is Gemini (section 3.4). |

## 5. Testing

- **Unit, pure:** the schema; `embeddings-to-gemini.ts` both directions,
  including base64 encoding, `outputDimensionality`, order preservation, the
  token-array refusal and `isTextInput`; `computeInputOnlyCost`; `paths.ts`
  with six endpoints.
- **Unit, adapter:** `embed` on the OpenAI adapters against a fake client
  factory — asserting the explicit `encoding_format` of section 3.3, the
  resolved path, and error classification; the same for Gemini against a fake
  `GoogleGenAI`.
- **Unit, ingress:** `tests/lib/gateway/embeddings-protocol.test.ts`, written
  as the sibling of `transcription-protocol.test.ts` — every seam the ingress
  implements, every seam it deliberately omits, and both `supports` rules in
  each direction.
- **End-to-end, gateway:** `tests/gateway/embeddings.test.ts` against a fake
  adapter — auth, limits, model resolution, failover across two targets, the
  log row, `usage.cost`, tags, dropped params, and payload capture; plus the
  four routing cases section 3.7 turns on. Both steering directions (an
  Anthropic-flavored target skipped and a Gemini target skipped for token ids,
  each with a sibling that serves), and both all-ineligible fallbacks (the 501
  through the *real* registry, so the message is the wrapper's; the 400 through
  the real translator). Each steering case asserts that the filtered candidate
  was never charged to the breaker, which is the difference between steering
  and a failed attempt.
- **Regression:** the whole pre-existing suite covers the seams adopted from
  `2fc5274` unchanged. Only `Ingress.cost` is new, so only the fake ingress in
  `ingress-seams.test.ts` needed a member added.

## 6. Rollout

Additive in every direction. A client that never calls `/v1/embeddings` sees no
change; the endpoint 404s today, so there is no behaviour to preserve. The
migration adds one nullable column.

Rollback is `git revert` plus dropping the column. No data is rewritten, and no
existing row's meaning changes.
