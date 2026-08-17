# Responses API (OpenAI-compatible) — design

The gateway serves `/v1/chat/completions` and calls every provider on
`/chat/completions`. This phase adds `/v1/responses` as a second ingress and
restores the ability to call a provider on `/responses`, so both protocols work
in both directions.

Supersedes `2026-08-13-responses-api-flavor-design.md`, whose egress half was
removed in `23dc469` and is restored here. Section 8 of that spec recorded the
seam this design attaches to; it is followed, with one change — flavor is now
resolvable per route target rather than per provider.

## 1. Problem

Two things are unreachable today.

**Clients that speak Responses cannot use the gateway at all.** The Agents SDK,
Codex, and anything built on `client.responses.create()` get a 404. This is not
a compatibility detail: hosted tools, reasoning items, and encrypted reasoning
have no Chat Completions expression, so a Chat-only ingress cannot serve those
clients even in principle.

**Providers that serve only `/responses` cannot be routed to.** `23dc469`
removed the Responses adapter, so such a provider is configurable in the
dashboard, passes credential validation, syncs its catalog — `GET /v1/models` is
a third endpoint and works either way — and then 404s on every request.

The two are one problem. With two ingress shapes and two egress shapes there are
four paths, and writing either translation ad hoc puts it in the wrong place for
the other three.

## 2. Scope

In scope:

- `POST /v1/responses`, streaming and non-streaming.
- `route_targets.api_flavor`, nullable, inheriting `providers.api_flavor`.
- `respond` / `respondStream` on `ProviderAdapter`.
- `src/lib/translate/responses-to-chat.ts` — new.
- `src/lib/translate/chat-to-responses.ts` and
  `src/lib/adapters/openai/responses.ts` — restored from `23dc469^`.
- A shared handler core under both ingresses.
- A per-target flavor picker in the models admin UI; the provider-level selector
  restored.

Out of scope, each by explicit decision:

- **`GET`/`DELETE`/cancel/`input_items` on `/v1/responses/{id}`.** Section 3.3.
- **`background: true`.** Rejected on every path, since a queued response would
  be unretrievable without the endpoints above.
- **Gateway-owned conversation state.** Section 3.2.
- **An `ingress` column on `request_logs`.** Section 3.7.
- **Flavor auto-detection.** A misconfigured flavor fails fast with a hint.
- **Feeding reasoning back upstream.** Carried forward from the superseded
  spec's section 3.3.

**One migration**, additive: a nullable column on `route_targets`. The
`api_flavor` enum and `providers.api_flavor` already exist in the database, so
there is no backfill and nothing a rollback breaks.

## 3. Decisions

| Decision | Choice |
|---|---|
| Flavor granularity | Per route target, inheriting the provider. Section 3.1. |
| Conversation state | Passed through to the provider. Section 3.2. |
| Response ids | Never rewritten. Section 3.3. |
| Sibling endpoints | `POST` only. Section 3.3. |
| Internal canonical form | None. Each ingress reaches each egress directly. |
| Crossing paths | Two wrappers applied in the registry, never per adapter. Section 3.4. |
| Unmappable parameters | Dropped and reported, unless they change the answer. Section 3.5. |
| Rejection semantics | Non-retryable, so no failover and no breaker impact. Section 3.5. |
| Handler duplication | One shared core, parameterised by an ingress descriptor. Section 3.6. |
| TTFT | Measured at the first content-bearing delta, both ingresses. Section 3.8. |

### 3.1 Why flavor is per target

The superseded spec put flavor on `providers` and recorded the upgrade path:
"every read goes through `resolveApiFlavor(provider)` in `registry.ts`, so
introducing a per-model layer later changes one function body rather than a
scatter of call sites." That layer is added now, because the reason to want
`/v1/responses` at all is that some models are only fully reachable through it.
Provider-wide flavor would force configuring OpenAI twice under two names with
duplicated credentials, purely to reach both halves of one account's catalog.

The column mirrors `route_targets.service_tier` exactly: nullable, no default,
where NULL is a distinct behaviour — "inherit the provider" — rather than a
missing value.

Resolution happens once, in `resolve.ts`, alongside the existing `serviceTier`
resolution. `Candidate` gains a non-null `apiFlavor`. A direct `provider/model`
address has no `route_targets` row and inherits the provider's flavor through
the same expression, so it is not a special case.

`createAdapter` becomes `createAdapter(provider, flavor = provider.apiFlavor)`.
`execute.ts` passes `candidate.apiFlavor`; `catalog/sync.ts` and
`admin/providers.ts` keep calling it with one argument, which is correct for
both — they hit `/v1/models`, which is the same endpoint under either flavor.

### 3.2 Why state is passed through, not owned

The Responses API is stateful by default. Three options existed: reject state
outright, store it in the gateway, or forward it.

Gateway-owned state would work uniformly across chat-only providers, but it is a
subsystem — a table, a retention policy, replay of stored turns into each
request — and it duplicates what the provider already does well.

So `store`, `previous_response_id`, and `conversation` are forwarded untouched to
a Responses-native target. The provider owns the conversation.

The cost is stated plainly: a response id is provider-scoped, so a follow-up is
only reliable when the virtual model has a single target. Section 9 records it.

### 3.3 Why ids are not rewritten, and why `POST` only

`/v1/chat/completions` rewrites `id` to a gateway-minted `chatcmpl-…`
(`identity.ts`). `/v1/responses` must not: the client sends that id back as
`previous_response_id`, and an id the provider has never seen is useless.

Encoding the target into a gateway id, or storing an id→target map, would both
let a follow-up be pinned to the target that minted it. Both were rejected as
machinery bought for a case a single-target virtual model already handles.

`model` is still rewritten to the virtual name, matching the other ingress.

On the translated path there is no upstream Responses id to pass through, so the
gateway mints `resp_<uuid>`. It is correctly unresolvable on a follow-up: the
target behind it is a stateless chat provider.

This also settles the sibling endpoints. `GET /v1/responses/{id}` carries no
`model` field, so with raw provider ids there is nothing to route on. Serving it
would require either a non-standard routing hint no OpenAI client sends, or a
fan-out across every Responses-capable provider. Both were rejected. The
endpoints 404 with a message naming the limitation.

### 3.4 Why two wrappers, not four adapters

There are two dialects, so N x M is four paths, of which two are identity. A
neutral internal representation would be a third dialect nothing speaks,
invented to save zero translators. Picking one dialect as canonical would make
the dominant flow — Chat in, Chat out — pay two translations to arrive where it
started.

So the request keeps the shape the client sent, and is translated only when the
resolved target flavor differs:

| resolved `apiFlavor` | `chat` / `chatStream` | `respond` / `respondStream` |
|---|---|---|
| `chat_completions` | passthrough | `responses-to-chat.ts` -> own `chat` |
| `responses` | `chat-to-responses.ts` -> own `respond` | passthrough |

The two crossing cells are supplied by wrappers applied once, in `registry.ts`:

```ts
const base = createOpenAIAdapter(runtime)   // or createGeminiAdapter(runtime)
return flavor === 'responses'
  ? withChatViaResponses(createResponsesAdapter(runtime))
  : withRespondViaChat(base)
```

There are two implementations of `respond` in the whole system, and no
per-adapter branches. Gemini gets `respond` from `withRespondViaChat`, the same
wrapper the OpenAI chat adapter uses; `chat-to-gemini.ts` is untouched and never
learns that Responses exists.

Nothing is lost to that composition that Gemini could otherwise have served:
`reasoning_effort` maps to `thinkingConfig` and thoughts return as
`reasoning_content` (`chat-to-gemini.ts:286-314`, `513-528`), and function tools
translate at line 308. The one class Chat Completions cannot carry is hosted
tools, which the Gemini adapter does not implement in any form.

Routing stays flavor-blind. Because all four cells exist, one virtual model may
mix Responses-native and chat-only targets and fail over between them.

### 3.5 Dropped versus rejected

The superseded spec's rule was "dropped, never fatal, always reported", and its
section 9 flagged the resulting weakness: "the one place the design returns a
wrong answer that looks right."

The rule is therefore split by blast radius. Parameters that shade the answer are
dropped and reported through the existing `x-babellm-dropped-params` header and
`request_logs.dropped_params`. Parameters that change the answer are rejected
with a 400 naming the parameter and the target.

Rejected: hosted tools (`web_search`, `file_search`, `code_interpreter`,
`image_generation`, `computer_use`, `mcp`); `previous_response_id` and
`conversation` against a chat-only target; `item_reference` input items;
`background: true` on every path.

Rejections are thrown in one of two places, and which one depends on whether the
rejection is path-dependent.

`background: true` is rejected for every target, so it is rejected at parse
time, by the ingress schema, as a `GatewayError(400)` before routing begins.

The rest — hosted tools, `previous_response_id`, `conversation`,
`item_reference` — are only unserviceable against a chat-only target, so they
depend on the resolved flavor. They live inside `withRespondViaChat` and surface
as a **non-retryable** `ProviderError(400)`.
Non-retryable matters twice: `execute` stops the chain rather than replaying a
doomed request against every target, and `recordHealth` is not called
(`execute.ts:177`), so a request-shape rejection cannot open a circuit breaker on
a target that is perfectly healthy.

Routing around the rejection — falling over to a Responses-native sibling that
could serve the hosted tool — was rejected. It needs a third error class,
retryable but health-neutral, which changes `execute.ts`'s contract, or it needs
`select.ts` to inspect the payload. Section 9 records the consequence.

### 3.6 Why one handler core

`chat-handler.ts` is 400 lines, of which the shape-specific parts are the zod
schema, `droppedFor`, the adapter call, the identity rewrite, and the SSE
framing. The rest is bookkeeping — request id minting, auth, limits, routing,
`execute`, the fire-and-forget log write with cost computation and
`chargeUsage`, and the catch block's `LimitExceededError` / `RoutedError` /
client-abort handling.

Duplicating that for a second ingress would put per-key budgets, payload
capping, health recording, and failover semantics in two copies that must be
fixed twice. `src/lib/gateway/handler.ts` takes it over, parameterised by:

```ts
interface Ingress<Req, Res, Chunk> {
  parse(raw: unknown): Req
  modelOf(req: Req): string
  isStream(req: Req): boolean
  droppedFor(candidate: Candidate, req: Req): string[]
  run(adapter, ctx, req): Promise<Res>
  runStream(adapter, ctx, req): AsyncIterable<Chunk>
  finish(res: Res, identity): Res
  usageOf(res: Res): LogUsage | null
  stream: StreamProtocol<Chunk>
}
```

Both route handlers become three lines over `runGatewayRequest`. The ordering
decisions currently encoded in comments — parse before `checkLimits` so a
malformed body cannot consume rpm, limits before `resolveModel` so a throttled
key is not told its model does not exist — stay in one place rather than being
copied and drifting.

Two things stay out of the descriptor. `bodyFor` is shared: both shapes carry
`service_tier` at the top level, so the pin is `{ ...body, service_tier }` for
either. `attemptHeaders` is shared and unchanged; every header it sets means the
same thing on both ingresses.

`execute.ts`, `select.ts`, `resolve.ts`, `health.ts`, `auth.ts`, and `errors.ts`
are otherwise untouched. `execute` is already generic over `run` and returns
`T`, and `errorBody` already emits `{error: {message, type, param, code}}` —
the same envelope the Responses API uses.

### 3.7 Why no ingress column on request_logs

A column would make the log viewer honest about which shape it is rendering and
answer "is anything using `/v1/responses`?". It was declined as not yet worth a
migration on a partitioned table. A Responses request is distinguishable only
when payload capture is on, which is off by default. Accepted.

### 3.8 Why TTFT moves

`ttftMs` is measured when `execute` resolves, i.e. on the first chunk. On the
Responses passthrough path the first event is `response.created`, which upstream
emits instantly, so every Responses stream would log a near-zero TTFT and
quietly poison the dashboard's figures once both ingresses share the table.

The measurement moves into the stream relay, at the first content-bearing delta,
for both ingresses. This also corrects a smaller existing inaccuracy: a chat
stream's first chunk is usually the role delta, not a token. It is a real change
to an existing metric and is called out as such.

## 4. The request translation

`src/lib/translate/responses-to-chat.ts`, a pure module with no client
dependency, mirroring `chat-to-responses.ts`: one module per round trip, holding
request-out and result-in together.

A string `input` becomes one user message. An array maps item by item:

| Responses input item | Chat message |
|---|---|
| `message` (`user`/`system`/`developer`) | same role; `input_text` -> text part, `input_image` -> `image_url` part |
| `message` (`assistant`) | assistant message; `output_text` -> content |
| `function_call` | assistant message with `tool_calls: [{id: call_id, function: {name, arguments}}]` |
| `function_call_output` | `{role: 'tool', tool_call_id: call_id, content: output}` |
| `reasoning` | dropped — summaries travel out only |
| `item_reference` | rejected — unresolvable without server-side state |

`instructions` becomes a leading `system` message. Consecutive `function_call`
items collapse into one assistant message carrying several `tool_calls`, which
is how Chat Completions represents a parallel call.

| Responses parameter | Chat parameter |
|---|---|
| `tools[].{name,parameters,strict}` (flat) | `tools[].function.{...}` (nested) |
| `tool_choice: {type:'function', name}` | `{type:'function', function:{name}}` |
| `text.format` (`json_schema`/`json_object`) | `response_format` |
| `reasoning.effort` | `reasoning_effort` |
| `max_output_tokens` | `max_completion_tokens` |
| `parallel_tool_calls`, `temperature`, `top_p`, `service_tier`, `user` | same name |
| `truncation`, `include`, `store`, `metadata`, `max_tool_calls`, `prompt_cache_key`, `safety_identifier`, `reasoning.summary` | dropped, reported |

Dropped parameters compose with the target's own losses: against a Gemini
target, this module's list and `chat-to-gemini.ts`'s `droppedParams` concatenate
into the one list the header and the log row carry.

## 5. The result translation

`choices[0].message` becomes output items in `output_index` order:
`reasoning_content` -> a `reasoning` item with a `summary_text`; `content` -> a
`message` item with an `output_text` part; each entry of `tool_calls` -> a
`function_call` item.

`finish_reason` maps to `status`: `stop` and `tool_calls` -> `completed`;
`length` -> `incomplete` with `incomplete_details.reason: 'max_output_tokens'`;
`content_filter` -> `incomplete`.

The request's own parameters — `instructions`, `tools`, `tool_choice`,
`temperature`, `text`, `reasoning`, `max_output_tokens` — are echoed onto the
response object, which is what the real API does and costs nothing, since the
request is in hand.

**Usage** is the only shape difference that reaches storage:

| Chat | Responses |
|---|---|
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |

`LogUsage` is already shape-neutral, so `usage.ts` gains a second normalizer,
`usageFromResponses`, and nothing downstream changes: `computeCost`, `priceFor`,
`chargeUsage`, per-key budgets, the hourly rollups, and the usage dashboard all
serve the new ingress unmodified. Absent counts stay `null` rather than `0`.

## 6. Streaming

`sse.ts` splits. The subtle part is protocol-independent and stays as written:
the `cancelled` and `settled` flags, single-settle discipline, the
`iterator.return()` cleanup on client disconnect, and capture accumulation with
its post-truncation guard at the call site. Only framing is parameterised:

```ts
interface StreamProtocol<Chunk> {
  frame(chunk: Chunk): Uint8Array
  terminator: Uint8Array | null
  errorEvent(err: ClassifiedError): Uint8Array
  accumulate(captured: StreamCapture, chunk: Chunk, maxBytes: number): void
  usageOf(chunk: Chunk): LogUsage | null
}
```

| | Chat | Responses |
|---|---|---|
| framing | `data: {...}` | `event: <type>` + `data: {...}` |
| terminator | `data: [DONE]` | none; `response.completed` is terminal |
| mid-stream error | `data: {error:{..., code:'stream_interrupted'}}` | `event: error` + `{type:'error', code, message, param}` |
| usage | `chunk.usage` on the final chunk | `response.usage` on `response.completed` |
| capture text | `delta.content` | `response.output_text.delta` |

`[DONE]` is omitted on the Responses ingress: the real API does not send it, and
the installed SDK treats it as optional (`openai/core/streaming.js:35`).

The translated stream is the inverse of the restored `fromResponseStream` and
inherits its one hard part — chat chunks are positional deltas, Responses events
are semantic and indexed by `output_index` over all items, while
`tool_calls[].index` counts only tool calls. The state machine emits:

1. `response.created`, then `response.in_progress`.
2. Per emerging item, in `output_index` order — reasoning first, then message,
   then function calls: `output_item.added`, then `content_part.added` for a
   message, then `output_text.delta` / `reasoning_summary_text.delta` /
   `function_call_arguments.delta`, then the matching `.done` events, then
   `output_item.done`.
3. `response.completed` carrying the assembled `Response` with usage — or
   `response.incomplete` when `finish_reason` was `length`.

`sequence_number` is minted by the gateway on the translated path and passed
through untouched on the passthrough path.

## 7. Admin UI

The provider-level selector and badge are restored from `23dc469^`
(`provider-form.tsx`, `edit-provider-form.tsx`, `actions.ts`, `page.tsx`) — 63
lines, restored rather than rewritten.

The per-target picker is new and mirrors `service-tier-select.tsx`: a shadcn
`Select` whose first option is "Inherit from provider (chat_completions)", wired
through `models/edit-target-form.tsx` and `models/actions.ts`, with a badge on
the target row in `models/[id]/page.tsx` shown only when the target overrides.

A 404 from a target marked `responses` carries the restored hint that the
provider may only speak Chat Completions, and its mirror on the chat side. Both
now name the target, since that is where the setting lives.

## 8. Phases

Each is independently verifiable.

1. **Handler core extraction.** Pure refactor, no Responses code, existing suite
   green. It touches the gateway's hottest path, so it lands alone.
2. **Flavor restored and made per-target.** The migration, `resolve.ts`, the
   `createAdapter` signature, both UIs, the restored `chat-to-responses.ts` and
   Responses adapter. At the end, chat-in to Responses-out works again as it did
   before `23dc469`.
3. **`/v1/responses`, passthrough only.** The route, the Responses
   `StreamProtocol`, `usageFromResponses`, the TTFT move. Responses-in to
   Responses-out is lossless end to end. `respond` is optional on
   `ProviderAdapter` until phase 4, so a Responses request routed to a chat-only
   target fails with the existing 501 `unsupported_operation` — which
   `classifyProviderError` already treats as non-retryable — rather than a
   missing method. Phase 4 removes the optionality and the 501 with it.
4. **`responses-to-chat.ts`.** The fourth cell, the shared `withRespondViaChat`
   wrapper that also gives Gemini `respond`, and the dropped/rejected policy.

## 9. Known limitations

- **No failover past a request-shape rejection.** A virtual model whose first
  target is chat-only and whose second is Responses-native will not fall over to
  the one that could have served a hosted tool. Section 3.5.
- **A stateful follow-up can land on the wrong target** when a virtual model has
  more than one. Reliable multi-turn state requires a single-target model.
  Section 3.2.
- **`GET`/`DELETE`/cancel/`input_items` and `background` are unsupported.**
  Section 3.3.
- **Reasoning is never fed back upstream.** On providers that expect a reasoning
  item to precede a function call, multi-turn tool loops may degrade against a
  chat-only target.
- **Hosted tools, audio, and image output are unreachable through a chat-only
  target**, by construction.
- **`reasoning_content` is a convention, not a standard**, and nothing
  downstream may treat it as guaranteed by OpenAI.
- **No flavor auto-detection.** A misconfigured flavor fails fast with a hint
  rather than being discovered and corrected.
- **Responses requests are not distinguishable in request logs** unless payload
  capture is enabled for the key. Section 3.7.

## 10. Testing

- `tests/lib/translate/responses-to-chat.test.ts` — the bulk, pure functions, no
  client. The restored `chat-to-responses.test.ts` sits beside it.
- `tests/gateway/mixed-flavor.test.ts` — restored and extended to all four
  cells, including failover across targets of differing flavor within one
  virtual model, and the non-retryable rejection leaving breakers untouched.
- `tests/contract/openai-client.test.ts` — drives the installed `openai` SDK's
  `client.responses.create()`, streaming and not, against the gateway. The only
  test that proves wire fidelity: `event:` lines, `sequence_number`
  monotonicity, terminal `response.completed`.
- `tests/lib/db/schema.test.ts` — the restored flavor assertions plus the target
  column.
- A browser check of the per-target picker on `pnpm dev:test-db` (port 3001,
  `babellm_dev` on 5434). Never `pnpm dev`.
