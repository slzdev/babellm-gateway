# Per-request cost in response metadata

**Date:** 2026-08-26
**Status:** Approved, ready for planning

## Problem

The gateway prices every request it serves, but no client can see the number.
`computeCost` runs inside `writeLog` (`src/lib/gateway/handler.ts`), which is
deliberately fire-and-forget *after* the response has been built. The cost
reaches the request log, the dashboard, and the key's spend counters — never
the caller.

A client that wants to attribute spend per request today has to re-derive it:
read `usage` off the response, guess which upstream model served (the virtual
name is all the body carries), find that model's rates, and reimplement the
cached-token subtraction. The last part is the one that goes wrong quietly,
because `cached_tokens` is a *subset* of `prompt_tokens` and charging both in
full double-counts every cache hit.

Give clients the number the gateway already computed.

## What ships

Every response whose usage can be priced carries a `cost` object nested inside
`usage`:

```json
{
  "id": "chatcmpl-…",
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 340,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "cost": {
      "currency": "USD",
      "input": "0.003000000",
      "cached": "0.000000000",
      "output": "0.005100000",
      "total": "0.008100000"
    }
  }
}
```

Same shape in all four paths: Chat and Responses, streaming and non-streaming.

### Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Channel | Body only, nested in `usage` | Headers cannot work for streams — usage arrives on the last chunk, long after headers flush. One channel means one contract that cannot drift between modes. |
| Opt-in | Always on | No migration, no key column, no UI toggle. Additive JSON; the OpenAI SDKs ignore unknown fields. |
| Detail | Breakdown, no rates | Clients see what they were charged and how it splits. Catalog per-Mtok rates stay in the admin surface rather than being published to every caller. |
| Representation | Strings, 9 decimals | Exactly what `computeCost` already returns and what the log stores. One number, one representation, everywhere. Numbers would reintroduce float error for a client summing many requests. |
| Unpriceable | `"cost": null` | See below. |

### Unpriceable requests

`computeCost` returns null for an uncatalogued model, a half-filled price row
(input but no output), or unmeasured tokens. Those requests get an explicit
`"cost": null`, not an absent key.

`src/lib/pricing.ts` already argues that showing `$0.00` for an unpriced model
is a lie. Omitting the key has the same flaw one level up: a client cannot
distinguish "this model has no catalog price" from "this gateway predates the
feature". An explicit null says the gateway looked and came up empty.

When `usage` itself is absent — a provider configured with
`disableStreamUsage`, or a clone that omits the field — nothing is attached at
all. A `usage` object is never fabricated just to carry a null cost.

## Design

### 1. Fetch the price before the response, not after

`priceFor()` is currently awaited inside `writeLog`. The response path needs it
earlier. After `execute()` returns the winning candidate, start
`priceFor(candidate.provider.id, candidate.upstreamModel)`.

**Non-streaming:** await it before building the response. Within the 60s TTL
this is a `Map` hit; a cold miss is one indexed catalog `SELECT`.

**Streaming:** do *not* await it there. `handler.ts` already documents that
nothing may sit between `execute()` and the response or it lands on
time-to-first-token — the payload-capture settings lookup is deliberately
placed behind a `capturePayloads` guard for exactly this reason. Instead hold
the unawaited promise and await it inside the relay loop **only on a chunk that
carries usage**, which is the last one. By then it resolved long ago, so the
await costs a microtask. Worst case — cold cache, very fast stream — it delays
the final chunk, never the first token.

**The promise must carry its own `.catch`** at creation:

```ts
const prices = priceFor(id, model).catch(() => null)
```

A stream that ends without usage never awaits it. Without the catch, a catalog
query that rejects becomes an unhandled rejection that can take down the
process — a failure mode that would only appear under database trouble, which
is precisely when it is least welcome.

### 2. One serializer

`computeCost` returns `CostBreakdown`: camelCase, and carrying the `pricing`
snapshot this design withholds. A single function produces the wire shape:

```ts
// src/lib/gateway/cost.ts
export interface CostPayload {
  currency: 'USD'
  input: string | null
  cached: string | null
  output: string | null
  total: string | null
}

export function costPayload(cost: CostBreakdown | null): CostPayload | null
```

It drops `pricing` deliberately — that omission is the decision, and it lives in
one place so no path can leak rates by accident. All four injection points call
it, so Chat and Responses cannot drift.

### 3. Injection points

| Path | Hook | Target |
|---|---|---|
| Chat, non-stream | `Ingress.finish` gains a third `cost` parameter | `res.usage.cost` |
| Chat, stream | new `StreamProtocol.attachCost(chunk, cost)` | final chunk's `usage.cost` |
| Responses, non-stream | same `finish` parameter | `res.usage.cost` |
| Responses, stream | same `attachCost` | `response.completed` → `response.usage.cost` |

`finish` is the right home for the non-streaming case: it already means "the
last transformation before the client sees it", which is exactly what this is.

**Two types, and they are not interchangeable.** Both hooks take an
already-serialized `CostPayload | null`, so no ingress calls `costPayload`
itself. But everything travelling toward the *log* stays a `CostBreakdown` —
`RequestLogEntry.cost` includes the `pricing` snapshot, and the request-detail
page renders the rates that priced the row. So `StreamCapture.cost` holds a
`CostBreakdown`, and the relay serializes to `CostPayload` at the moment of
framing. Narrowing `StreamCapture` to the wire type would silently strip
`pricing` out of every log row.

`attachCost` is called in the relay loop immediately before `frame()`, and only
when `protocol.usageOf(chunk)` returned non-null. Some translated providers
report usage on more than one chunk (Anthropic always reports it); cost is
attached to each usage-bearing chunk, computed from that chunk's own numbers.
This mirrors `captured.usage`, which is last-wins for the same reason.

**Typing.** `ChatCompletion` and `ResponsesResult` are the OpenAI SDK's own
types (`OpenAI.Chat.Completions.ChatCompletion`, `OpenAI.Responses.Response`),
which cannot express an extra `usage.cost`. Attachment therefore needs one
documented `as Res` cast per helper. The cast is the honest signal that this is
a deliberate extension of someone else's wire format, and confining it to the
two `attachCost`/`finish` helpers keeps it from spreading.

### 4. The log stops recomputing

Once the handler holds the cost, thread it into `LogExtra`, and give
`StreamCapture` a `cost` field beside its existing `usage`. `writeLog`'s
`await priceFor(...)` then disappears.

Beyond removing a duplicate lookup from the logging path, this makes three
numbers provably the same object: what the client received, what the request
log row stores, and what `chargeUsage` bills against the key's budget. Today a
client comparing its own tally against the dashboard has no guarantee they were
computed from the same snapshot — the log's lookup happens later and could
cross a price change or a TTL boundary.

Paths that never attach a cost (errors, limit rejections, streams that ended
before usage arrived) already log `cost: null`, because `writeLog` guards on
`extra.candidate && usage`. No fallback recomputation is needed.

## Testing

Extends the existing suites rather than adding new files:

- `tests/gateway/chat.test.ts` — breakdown present and arithmetically correct;
  unpriced model yields `cost: null`; a cached-token request splits into
  `cached` with the cached rate and does not double-charge the prompt.
- `tests/gateway/chat-stream.test.ts` — final chunk carries `usage.cost`; a
  provider with `disableStreamUsage` produces no usage object and no cost; an
  interrupted stream that never reached usage logs `cost: null`.
- `tests/gateway/responses-ingress.test.ts` — non-stream `res.usage.cost`, and
  the streaming `response.completed` event's `response.usage.cost`.
- `tests/gateway/request-logging.test.ts` — the logged row's cost equals the
  cost in the response body, for both stream and non-stream.
- `tests/lib/` — `costPayload` unit tests: null in, null out; `pricing` never
  appears in the output.

A price-lookup rejection must not fail the request: assert the `.catch(() =>
null)` path yields `cost: null` and a served response.

## Out of scope

- Currencies other than USD. The `currency` field is present so the contract
  does not have to change later, but it is the constant `"USD"`.
- Exposing catalog rates to clients.
- Per-key or per-request opt-out. Revisit if a client is found that rejects
  unknown fields inside `usage`; the natural shape is a `return_cost` column on
  `api_keys` alongside `log_payloads`.
- Cumulative or session-level spend in the response. This is per-request only.
