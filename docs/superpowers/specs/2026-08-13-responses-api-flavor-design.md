# Responses API Flavor — design

Some OpenAI-compatible providers serve `/v1/responses` but not
`/v1/chat/completions`. This phase lets a provider be marked as speaking either
protocol while `/v1/chat/completions` stays the gateway's only ingress, and puts
the translation behind the existing adapter boundary so nothing in the routing
loop learns about it.

## 1. Problem

`createAdapter` maps both OpenAI-shaped adapter types onto one implementation:

```ts
case 'openai':
case 'openai_compatible':
  return createOpenAIAdapter(runtime)
```

`createOpenAIAdapter` calls `client.chat.completions.create` and nothing else.
A provider whose endpoint implements only the Responses API is therefore
configurable in the dashboard, passes credential validation, syncs its catalog
happily — `GET /v1/models` is a third endpoint and works for both — and then
returns `404` on every actual request. The failure arrives as a fatal upstream
error naming a provider, with nothing to suggest the endpoint was the problem.

There is no second thing to try, either: `route_targets` can fail over between
providers, but every provider in the chain speaks the same protocol, so a
Responses-only endpoint cannot participate in a chain at all.

A second, later problem sits behind this one. The gateway will eventually expose
`/v1/responses` as well. At that point there are two ingress shapes and two
egress shapes, and if the first translation is written ad hoc it will be in the
wrong place — inside a route handler, or inside the OpenAI adapter's `chat`
method — and the second one will be written somewhere else again.

## 2. Scope

In scope:

- An `api_flavor` column on `providers`, with values `chat_completions` and
  `responses`.
- `createResponsesAdapter`: a `ProviderAdapter` that speaks Responses upstream
  and Chat Completions downstream.
- `src/lib/translate/chat-to-responses.ts`: pure translation of a Chat
  Completions request into a Responses request, and of a Responses result and
  event stream back into a Chat Completions result and chunk stream.
- Reporting of request parameters the Responses API cannot express, via a
  response header and the request log line.
- A flavor selector and badge in the provider admin UI.
- A hint on upstream `404`s pointing at the flavor setting.

Out of scope, each deferred by explicit decision:

- **`/v1/responses` as an ingress.** Section 8 records the seam it will attach
  to. No method, and no stub for one, is added now.
- **Per-model flavor.** Provider-level only. Section 3.1.
- **Stateful conversations.** `store` is pinned to `false`; no
  `previous_response_id`, no `conversation`.
- **Feeding reasoning back upstream.** Summaries travel out only. Section 3.3.
- **Emulating dropped parameters.** No client-side `stop` truncation, no `n`
  fan-out. Section 3.4.
- **Flavor auto-detection.** No probe button, no fallback-on-404 retry.
- Hosted tools, audio, and image output. Unreachable through a Chat Completions
  ingress by construction, and the reason `/v1/responses` will eventually exist.

**One migration**, additive: a new enum and a column with a default. No backfill.

## 3. Decisions

| Decision | Choice |
|---|---|
| Where flavor lives | A column on `providers`, not an `adapter` enum value and not a `config` key. |
| Granularity | Provider-wide. Read through a single `resolveApiFlavor`. |
| Where translation lives | A pure module under `src/lib/translate/`, called by a dedicated adapter. |
| Module boundary | One module per round trip, holding request-out and result-in together. |
| Internal canonical form | None. Each ingress reaches each egress directly. |
| Unmappable parameters | Dropped, never fatal, always reported. |
| Reasoning | Summaries out as `reasoning_content`; never fed back. |
| Reasoning summary request | Only when the client sends `reasoning_effort`, or the provider opts in. |
| Server-side state | `store: false`, always. |
| Stream commit point | Unchanged: the first real content or tool-call chunk. |

### 3.1 Why a column, and why provider-wide

`adapter` selects the credential schema — `credentialSchemas` is keyed by it —
and the SDK family. Flavor is orthogonal to both: same credentials, same SDK,
same base URL, a different endpoint. Adding `openai_responses` and
`openai_compatible_responses` would take the enum from four values to six and
duplicate every credential-schema entry, while remaining meaningless for
`gemini` and `bedrock`.

Nor does it belong in the `config` JSON blob beside `timeoutMs` and
`disableStreamUsage`. Those are tuning knobs. Which protocol a provider speaks
is the same class of fact as `adapter` and `base_url`: it decides whether a
request can be served at all, it should be visible in a list query, and the
database should constrain it.

Provider-wide is a real limitation. OpenAI itself serves both surfaces, and some
models are reachable only through Responses, so a single flag can make part of a
provider's catalog unreachable. The workaround is to configure the provider
twice under different names, which costs a duplicated credential row and
nothing else. The upgrade path is deliberately cheap: every read goes through
`resolveApiFlavor(provider)` in `registry.ts`, so introducing a per-model layer
later changes one function body rather than a scatter of call sites.

### 3.2 Why no internal canonical form

The obvious "correct" answer to two ingresses and two egresses is a neutral
internal representation — N + M translators instead of N × M. It is wrong here
for two reasons.

There are only two dialects, so N × M is four paths, of which two are identity.
That leaves exactly two real translators: Chat Completions ↔ Responses, in both
directions. A neutral IR would be a third dialect that nothing on either side of
the gateway speaks, invented to save zero translators.

Picking one of the two as canonical is the other tempting variant, and it makes
the common case worse. Today's dominant flow is Chat Completions in, Chat
Completions out. Normalising to Responses at the door would make that flow pay
two translations to arrive where it started, rewrite a path that is already
tested end to end, and force `identity.ts` and `sse.ts` to grow Responses
equivalents now rather than when `/v1/responses` actually ships.

So: no canonical form. The request keeps the shape the client sent, and is
translated only when the target flavor differs. Each of the two translators
serves in both roles — the module written in this phase runs egress-side today,
and becomes ingress-side for a Chat Completions provider once `/v1/responses`
exists.

### 3.3 Why summaries out and nothing back

Responses emits `reasoning` items as first-class output. Chat Completions has no
standard slot for them, and with `store: false` there is no
`previous_response_id` to lean on, so anything the model needs on its next turn
must survive a round trip out through `/v1/chat/completions` and back in.

Three options were considered: drop reasoning entirely; emit summaries as
`message.reasoning_content` / `delta.reasoning_content`, the de-facto convention
DeepSeek, vLLM and OpenRouter already use; or round-trip
`reasoning.encrypted_content` so reasoning state survives statelessly.

Summaries-out is chosen. Dropping reasoning throws away most of what a user is
waiting for on a reasoning model. The encrypted round trip is the only fully
correct option, but it needs an encode/decode contract, graceful degradation
when a client strips the field, and it only works with clients that echo the
assistant message back verbatim — a phase of its own.

The cost is recorded in Section 9: on providers that expect a reasoning item to
precede a function call, multi-turn tool loops may degrade.

### 3.4 Why unmappable parameters are dropped rather than rejected

`n`, `stop`, `logit_bias`, `logprobs`, `top_logprobs`, `frequency_penalty`,
`presence_penalty` and `seed` have no Responses equivalent. Rejecting them
breaks well-behaved clients: SDKs and frameworks routinely send
`frequency_penalty: 0` and `presence_penalty: 0` unprompted, meaning nothing by
it. A gateway that 400s on those is unusable against a Responses provider
without per-client configuration.

So no request ever fails because of a flavor difference. The honest cost is that
two of these change the answer when dropped: `n > 1` yields one choice instead
of many, and `stop` sequences quietly stop applying. Both are reported in
`x-babellm-dropped-params` and in the request log line, and both are documented
in the README, because a wrong answer that looks right is not discoverable by
anyone who has not been told.

### 3.5 Why the stream commit point does not move

`startChatStream` pulls the first chunk eagerly, and that pull is simultaneously
the failover boundary and the `ttftMs` measurement. A Responses stream opens
with `response.created`, which arrives as soon as the upstream accepts the
request — long before any content.

Mapping `response.created` to the conventional opening `delta: {role:
'assistant'}` chunk would therefore commit the HTTP response at acceptance
time. A generation failure that today fails over cleanly to the next target
would instead reach the client as an SSE `error` event, and `ttftMs` would stop
measuring time to first token. So the translator holds `role: 'assistant'` and
merges it into the first real content or tool-call chunk. Role arriving on the
first content chunk is valid Chat Completions and is handled by every client.

## 4. Components

### 4.1 `src/lib/db/schema.ts`

```ts
export const apiFlavorEnum = pgEnum('api_flavor', ['chat_completions', 'responses'])

// providers:
apiFlavor: apiFlavorEnum('api_flavor').notNull().default('chat_completions'),
```

The default makes the migration additive with no backfill; every existing row
keeps its current behaviour.

This is the fifth `pgEnum` in the schema. The SQLite design
(`2026-08-13-sqlite-support-design.md`) maps every `pgEnum` to
`text({ enum: [...] })` under one general rule rather than listing enums
individually, so `api_flavor` needs no entry there and that spec is
unaffected by this phase.

### 4.2 `src/lib/adapters/types.ts`

`ProviderRuntime` gains `apiFlavor: ApiFlavor`. `ProviderAdapter` is unchanged —
that it does not move is the point of the whole design.

`ProviderConfig` gains one optional key:

```ts
/**
 * Ask a Responses-flavored provider for reasoning summaries even when the
 * client did not send `reasoning_effort`. Off by default: sending `reasoning`
 * to a non-reasoning model is an error on OpenAI-shaped endpoints, and the
 * gateway cannot tell which it is talking to.
 */
requestReasoningSummary?: boolean
```

### 4.3 `src/lib/adapters/registry.ts`

`resolveProviderRuntime` copies `apiFlavor` through. A new
`resolveApiFlavor(provider: ProviderRow): ApiFlavor` is the single read point.

```ts
case 'openai':
case 'openai_compatible':
  // existing baseUrl guard for openai_compatible is unchanged
  return resolveApiFlavor(provider) === 'responses'
    ? createResponsesAdapter(runtime)
    : createOpenAIAdapter(runtime)
```

### 4.4 `src/lib/adapters/openai/client.ts` (new)

Client construction and `listModels` are identical for both flavors — the
credential shape is the same and `GET /v1/models` is a third endpoint that both
kinds of provider serve. Both are extracted here so the two adapters share them
rather than diverging by copy-paste.

`createOpenAIAdapter` and `createResponsesAdapter` both keep the
`OpenAIClientFactory` injection parameter that `createOpenAIAdapter` already
has, so both test the same way.

Catalog sync, the catalog page and direct addressing need no changes at all.

### 4.5 `src/lib/adapters/openai/responses.ts` (new)

`createResponsesAdapter(runtime, createClient?)`. Implements `chat`,
`chatStream` and `listModels`.

`chat` calls `client.responses.create` with
`{...toResponsesRequest(req, ctx.upstreamModel, runtime.config), stream: false}`
and returns `fromResponse(result)`. `chatStream` does the same with `stream:
true` and pipes the events through `fromResponseStream`. Both wrap failures in
`toProviderError`, and `chatStream` wraps both the opening call and the
iteration separately, exactly as `createOpenAIAdapter` does today and for the
same reason.

The adapter holds no translation logic; it is the seam between a client and the
pure module.

### 4.6 `src/lib/translate/chat-to-responses.ts` (new)

The whole round trip lives in one file, because the halves must agree with each
other. A client's `tool_calls[].id` goes out as `call_id` and has to come back
as `tool_calls[].id` unchanged, or a tool loop breaks silently on its second
turn. Split across files, that invariant has nowhere to live.

Exports:

```ts
toResponsesRequest(req, upstreamModel, config) → ResponseCreateParams
fromResponse(res) → ChatCompletion
fromResponseStream(events, req) → AsyncIterable<ChatCompletionChunk>
droppedParams(req) → string[]
```

`droppedParams` is separate from `toResponsesRequest` rather than a second
return value, because the adapter never needs it and the handler cannot reach
the adapter's return. One function, two callers, no channel through
`ProviderAdapter` — see Section 4.7.

No SDK client, no network, no database.

#### 4.6.1 Request

`EasyInputMessage` accepts `system` and `developer` roles directly, so system
messages stay in place as input items. Hoisting them into `instructions` would
reorder a conversation that interleaves system turns and buys nothing.

| Chat Completions | Responses |
|---|---|
| `user` / `system` / `developer`, string content | same role, string content |
| content part `text` | `input_text` |
| content part `image_url` | `input_image` (`image_url`, `detail` defaulting to `auto`) |
| `assistant` content | `assistant` role message |
| `assistant.tool_calls[]` | one `function_call` item each, `call_id` ← `tool_call.id` |
| `tool` / legacy `function` | `function_call_output`, `call_id` ← `tool_call_id` |

Parameters:

| Chat Completions | Responses |
|---|---|
| `max_completion_tokens`, else `max_tokens` | `max_output_tokens` |
| `temperature`, `top_p`, `parallel_tool_calls` | unchanged |
| `response_format` | `text.format`; `json_schema.{name,schema,strict}` flattens |
| `tools[].function.{...}` | flat `{type:'function', name, description, parameters, strict}` |
| `tool_choice: {type:'function', function:{name}}` | `{type:'function', name}` |
| `user` | `safety_identifier` |
| — | `store: false`, always |

`stream_options.include_usage` is satisfied rather than dropped: Responses
always reports usage on completion, so the translator emits a usage chunk unless
the client explicitly set `include_usage: false`. The `disableStreamUsage`
config key is a workaround for clones that reject `stream_options` on the
request, and since that parameter is never sent to a Responses endpoint the key
is a no-op for these providers.

Reasoning is requested only when `req.reasoning_effort` is present — in which
case `reasoning: { effort, summary: 'auto' }` — or when
`config.requestReasoningSummary` is set. Reasoning items that arrive unrequested
are translated regardless. `reasoning_effort` is added explicitly to
`chatCompletionRequestSchema`, since the translator now reads it rather than
passing it through blind.

Dropped and reported: `n`, `stop`, `logit_bias`, `logprobs`, `top_logprobs`,
`frequency_penalty`, `presence_penalty`, `seed`, audio content parts.

#### 4.6.2 Result

`res.output` is walked once, accumulating into a single choice — `n` is always 1.

- `message` items: `output_text` parts concatenate into `content`; `refusal`
  parts into `message.refusal`.
- `function_call` items: appended to `tool_calls[]`, `id` ← `call_id`.
- `reasoning` items: `summary[].text`, and `content[]` entries of type
  `reasoning_text`, concatenate into `message.reasoning_content`.
- Hosted-tool items (`web_search_call`, `file_search_call`,
  `code_interpreter_call`, `mcp_call`, `image_generation_call`, …): dropped and
  reported. They can only appear if a provider injects tools server-side, since
  a Chat Completions request cannot ask for them.

`finish_reason` is derived: tool calls present → `tool_calls`; `status ===
'incomplete'` with `incomplete_details.reason === 'max_output_tokens'` →
`length`, with `content_filter` → `content_filter`; otherwise `stop`.

Usage maps `input_tokens` → `prompt_tokens`, `output_tokens` →
`completion_tokens`, `total_tokens` → `total_tokens`,
`output_tokens_details.reasoning_tokens` →
`completion_tokens_details.reasoning_tokens`, and
`input_tokens_details.cached_tokens` → `prompt_tokens_details.cached_tokens`.

`id` and `model` are passed through and do not matter: `rewriteCompletion` in
`identity.ts` overwrites both downstream.

#### 4.6.3 Stream

Chat Completions chunks are positional deltas on `choices[0].delta`. Responses
events are semantic and indexed by `output_index`, which counts *all* output
items including reasoning and messages, while `tool_calls[].index` counts only
tool calls. The translator is therefore a small stateful generator holding one
map from `output_index` to a dense tool-call slot, plus the pending-role flag
from Section 3.5.

| Event | Chunk |
|---|---|
| `response.output_text.delta` | `delta.content` |
| `response.refusal.delta` | `delta.refusal` |
| `response.reasoning_summary_text.delta` | `delta.reasoning_content` |
| `response.reasoning_text.delta` | `delta.reasoning_content` |
| `response.output_item.added` (`function_call`) | `delta.tool_calls[{index, id: call_id, type, function.name}]` |
| `response.function_call_arguments.delta` | `delta.tool_calls[{index, function.arguments}]` |
| `response.completed` / `response.incomplete` | final chunk with `finish_reason`, then a usage chunk unless `include_usage: false` |
| `response.failed` | throw, so `toProviderError` classifies it |
| `error` | throw, same as `response.failed` — it is a top-level stream event, not a response status, and a clone can emit it mid-stream instead of `response.failed`. Dropping it would end the stream cleanly, so a truncated answer would reach the client as a successful response. |

Every other event is ignored: all `.done` events, `response.created`,
`response.in_progress`, `response.queued`, `content_part.*`,
`output_item.done`, `reasoning_summary_part.*`, annotations, and hosted-tool
progress. The `.done` events restate what the deltas already delivered, and
translating them is how every response ends up duplicated. This is the most
likely bug in the file and has a named test.

### 4.7 Dropped-parameter reporting

`toResponsesRequest` knows what it dropped, but it runs inside the adapter,
inside `execute`, while headers are built in `chat-handler` from
`attemptHeaders(result.candidate, requestId)`. Returning that through
`ProviderAdapter` would put translation-specific knowledge into the interface
every future adapter implements.

Instead `droppedParams(req)` is exported standalone and called from
`chat-handler` after `execute` resolves, against the winning candidate —
`result.candidate.provider` plus `resolveApiFlavor` is everything it needs. The
adapter uses the same function internally. Nothing new crosses the adapter
boundary.

This works identically for streams: `execute` already resolves at the first
chunk, and `sseResponse` sets headers after that.

Output goes to `x-babellm-dropped-params` on the response and to a field on the
request log line, so the JSON line stays the complete record it claims to be.

No `x-babellm-api-flavor` header is added. Flavor is provider-level and
`x-babellm-provider` is already on every response, so it would be a second name
for a fact the client already has.

### 4.8 `src/lib/adapters/openai/errors.ts`

`toProviderError` classifies `OpenAI.APIError`, which is the same class from
both endpoints, so retryability, status mapping and failover need no changes.

One addition: when either flavor's provider returns `404`, the message is
extended to name the flavor setting to change. A `404` is already fatal, so the
request fails fast with the provider named in `x-babellm-provider`; the only
thing missing is the hint. This converts the most likely configuration mistake
from a mystery into an instruction, in both directions — the dashboard's
one-click flavor control makes the `responses`-set-on-a-Chat-Completions-only
endpoint mistake exactly as reachable as the reverse, so the hint is
symmetric: `src/lib/adapters/openai/index.ts` and
`src/lib/adapters/openai/responses.ts` each carry their own `FLAVOR_HINT`
constant naming the other flavor.

### 4.9 Admin UI

`ProviderListItem` gains `apiFlavor`. `ProviderInput` gains an optional
`apiFlavor`, defaulting to `chat_completions` on create and preserved on update
like the other scalar fields.

The provider create and edit forms get a shadcn `Select`, rendered only for
`openai` and `openai_compatible`, with helper text naming the symptom rather
than the mechanism ("choose Responses if this endpoint returns 404 on
`/v1/chat/completions`"). The providers table shows a `Badge` when the flavor is
`responses`.

Saving a provider still re-syncs it; that behaviour is unchanged.

## 5. Request lifecycle

Unchanged up to the adapter, and unchanged after it:

1. `handleChatCompletions` parses and validates the Chat Completions body.
2. `resolveModel` and `selectOrder` build the attempt chain.
3. `execute` walks it. For each candidate, `createAdapter` returns whichever
   adapter that provider's flavor calls for.
4. A Responses-flavored adapter translates the request, calls
   `client.responses.create`, and translates the result or event stream back
   into Chat Completions shapes.
5. `execute` sees a `ChatCompletion` or a first `ChatCompletionChunk` and cannot
   tell which flavor produced it.
6. `identity.ts` rewrites ids and model names; `sse.ts` frames the stream.
7. `chat-handler` computes dropped parameters for the winning candidate and adds
   the header and log field.

A chain may therefore mix flavors freely. A Responses provider that 429s fails
over to a Chat Completions provider and the client sees one coherent response.

## 6. Error handling

| Situation | Behaviour |
|---|---|
| Upstream `404` on a `chat_completions` provider | Fatal, with a message naming the flavor setting. |
| Upstream `404` on a `responses` provider | Fatal, with a mirrored message naming the flavor setting — the dashboard makes this misconfiguration exactly as reachable as the other one. |
| Upstream 429 / 5xx / timeout | Retryable; fails over, possibly onto the other flavor. |
| `response.failed` mid-stream | Thrown, classified, surfaced as an SSE `error` event by `sse.ts`. |
| `error` top-level stream event | Thrown, same as `response.failed`. |
| Unmappable request parameter | Never an error. Dropped and reported. |
| Hosted-tool output item | Never an error. Dropped and reported. |

## 7. Testing

TDD throughout. Four layers.

**Translator units** — `tests/lib/translate/chat-to-responses.test.ts`. Pure data
in, data out: message and content-part mapping, the `tool_call.id` ↔ `call_id`
round trip in both directions, parameter mapping, `finish_reason` derivation
from each of its four sources, usage mapping including reasoning and cached
tokens, and the dropped-parameter list.

**Stream translation** — against a recorded fixture,
`tests/fixtures/openai-responses-tool-call-stream.json`, mirroring the existing
`openai-tool-call-stream.json`. Named assertions for the three failure modes
this file is most prone to:

- no content is duplicated by `.done` events;
- `role: 'assistant'` is merged into the first real chunk and never emitted
  alone;
- tool-call indices are dense and 0-based while `output_index` is neither.

**Adapter** — `tests/lib/adapters/openai/responses-{chat,stream,models}.test.ts`,
using the existing `OpenAIClientFactory` injection. No new harness.

**Gateway integration** — a Responses provider served end to end through
`/v1/chat/completions`, streaming and non-streaming; the dropped-parameter
header; and the test that proves the design holds: a **mixed failover chain**
where a Responses provider fails and a Chat Completions provider serves,
producing one coherent response.

`tests/contract/openai-client.test.ts` gains a real-SDK pass against a
Responses-backed provider.

## 8. The `/v1/responses` seam

Recorded so the next phase attaches to a decision rather than improvising one.
Nothing below is built now, and no stub for it is added.

`ProviderAdapter` grows an optional `respond` / `respondStream` pair. The
Responses adapter implements them as passthrough. The Chat Completions adapter
implements them through the mirror module,
`src/lib/translate/responses-to-chat.ts`, which holds its own round trip the way
`chat-to-responses.ts` holds this one. `identity.ts` and `sse.ts` grow Responses
equivalents at that point.

Both matching paths stay lossless: Chat Completions in and out never translates,
Responses in and out never translates, and neither ever round-trips through the
other.

## 9. Known limitations

- **`n > 1` and `stop` are silently ineffective** against a Responses provider.
  This is the one place the design returns a wrong answer that looks right. The
  header, the log line and the README are the mitigation.
- **Reasoning is not fed back upstream.** On providers that expect a reasoning
  item to precede a function call, multi-turn tool loops may degrade. The
  upgrade path is the encrypted stateless round trip, as its own spec.
- **`reasoning_content` is a convention, not a standard.** Documented as such so
  nothing downstream treats it as guaranteed by OpenAI.
- **Flavor is provider-wide**, so a provider serving both surfaces must be
  configured twice to reach models exclusive to each. Section 3.1.
- **No auto-detection.** A misconfigured flavor fails fast with a hint rather
  than being discovered and corrected.
- **Hosted tools, audio and image output are unreachable** through a Chat
  Completions ingress.

## 10. Files touched

New:

- `src/lib/translate/chat-to-responses.ts`
- `src/lib/adapters/openai/responses.ts`
- `src/lib/adapters/openai/client.ts`
- `drizzle/` migration
- `tests/lib/translate/chat-to-responses.test.ts`
- `tests/lib/adapters/openai/responses-{chat,stream,models}.test.ts`
- `tests/fixtures/openai-responses-tool-call-stream.json`

Modified:

- `src/lib/db/schema.ts` — enum and column
- `src/lib/adapters/types.ts` — `ProviderRuntime.apiFlavor`, `ProviderConfig.requestReasoningSummary`
- `src/lib/adapters/registry.ts` — `resolveApiFlavor`, flavor branch
- `src/lib/adapters/openai/index.ts` — client and `listModels` extracted out
- `src/lib/adapters/openai/errors.ts` — `404` hint
- `src/lib/schemas/chat.ts` — `reasoning_effort`
- `src/lib/gateway/chat-handler.ts` — dropped-parameter header
- `src/lib/gateway/request-log.ts` — dropped-parameter field
- `src/lib/admin/providers.ts` — `apiFlavor` on input and list item
- `src/app/(admin)/providers/{provider-form,edit-provider-form,page}.tsx`
- `src/app/(admin)/providers/actions.ts`
- `README.md` — flavor setting, `reasoning_content`, and the `n`/`stop` caveat

Not modified: `docs/superpowers/specs/2026-08-13-sqlite-support-design.md`. Its
general `pgEnum` → `text({ enum: [...] })` rule already covers `api_flavor`;
see §4.1.
