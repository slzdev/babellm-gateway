# Anthropic Messages API flavor

Date: 2026-08-18
Status: designed, to be implemented on `worktree-responses-api`

## Problem

A model can be served on Chat Completions or on the Responses API, and since
the per-model flavor change it says which of the two for itself. A third
dialect is missing: the Anthropic Messages API, which is what Claude models
answer on natively and what a growing number of OpenAI-shaped clones expose
beside their OpenAI route.

Today the only way to reach such an endpoint through this gateway is not to —
`createAdapter` knows two flavors, and both speak an OpenAI dialect.

## Decision

`anthropic_messages` becomes a third value of `api_flavor`, settable on a model
exactly as the other two are, and inherited from the provider when the model
says nothing.

Clients keep speaking Chat Completions and the Responses API. The gateway
translates their requests into Messages requests on the way out and translates
what comes back on the way in. No client-facing `/v1/messages` ingress is added
— a request never arrives in Anthropic's dialect, so nothing needs to translate
out of it.

The flavor is available on the `openai` and `openai_compatible` adapters, the
same two the Responses flavor applies to. It is not a new adapter type:
adapter type is provider-wide, and the requirement is per-model.

## 1. The flavor

`API_FLAVORS` gains `'anthropic_messages'` and `API_FLAVOR_LABELS` gains
`Anthropic Messages`. Every screen that renders a flavor is built from those
two, so the provider form, the catalog's gateway-settings dialog and the
read-only badge on the virtual-model detail page all pick the value up without
edits.

Migration `0009` runs `ALTER TYPE "api_flavor" ADD VALUE 'anthropic_messages'`
and adds `catalog_models.messages_path` (see §3). Postgres will not let a value
added to an enum be used in the same transaction it was added in; the migration
only declares the value and adds a `text` column, so nothing in it uses the new
label. If drizzle-kit's generated SQL turns out to need splitting for that
reason, split it into two migrations rather than hand-editing one to run
outside a transaction.

`registry.ts` grows a third branch. `openAIShaped` is renamed — it no longer
describes what it returns:

```ts
function flavoredAdapter(runtime: ProviderRuntime, flavor: ApiFlavor): ProviderAdapter {
  if (flavor === 'responses') return createResponsesAdapter(runtime)
  if (flavor === 'anthropic_messages') {
    return withRespondViaChat(createAnthropicAdapter(runtime), runtime.name)
  }
  return withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
```

Gemini and bedrock are untouched: flavor still says nothing about an adapter
that speaks neither OpenAI dialect.

## 2. The adapter

`src/lib/adapters/anthropic/` holds `index.ts`, `client.ts` and `errors.ts`,
laid out like the Gemini folder:

- `client.ts` builds an `@anthropic-ai/sdk` client from `runtime.baseUrl` and
  `credentials.apiKey` — sent as `x-api-key`, which is what the SDK does with
  an api key — honouring `config.timeoutMs`. It takes an injectable factory,
  as `openai/client.ts` and `gemini/client.ts` do, so the adapter is testable
  without a network.
- `index.ts` returns a `ChatOnlyAdapter`: `chat`, `chatStream` and
  `listModels`. It holds no translation logic — that lives in the pure module
  of §5 — and it never learns that the Responses API exists.
- `errors.ts` maps `Anthropic.APIError` subclasses onto `ClassifiedError`, the
  job `openai/errors.ts` does for its own SDK, and carries a `FLAVOR_HINT` for
  the misconfiguration this flavor makes newly reachable: an endpoint that does
  not implement `/v1/messages`.

`respond`/`respondStream` come from `withRespondViaChat`, so a Responses
request crosses twice — Responses → Chat → Messages — and `assertServiceable`
refuses hosted tools and `previous_response_id` before either crossing runs.

**Open item for the first implementation step.** The design assumes the
Anthropic SDK honours a per-request `path` option, as the OpenAI SDK does at
`openai/index.ts`'s call sites; both clients are Stainless-generated, so it
almost certainly does. Verify it against the installed package before building
on it. If it does not, use `client.post(path, { body, stream })`, which the
same client exposes, and keep everything else in this design unchanged.

## 3. Paths

Nothing about path resolution changes; the existing rule gains a fourth
endpoint. `DEFAULT_PATHS` gains `messages: '/messages'` — relative, so it joins
onto a base URL that carries its own `/v1`, and a configured path resolves
against the base URL's origin instead. Because the adapter always passes an
explicit path, the Anthropic SDK's own `/v1/messages` default never applies and
cannot double the prefix.

Consequently:

- `ProviderConfig` gains `messagesPath`.
- `PATH_FIELDS` gains a "Messages path" entry and `MODEL_PATH_FIELDS` gains its
  model-facing counterpart, which is what puts the input on both the provider
  form and the catalog's gateway dialog.
- `ModelPathOverrides` gains `messagesPath`, `withModelPaths` folds it like the
  other two, `resolve.ts`'s `modelPaths()` reads the new column, and
  `setModelGateway` validates it through `parseProviderPath`.

`paths.ts` moves from `src/lib/adapters/openai/` to `src/lib/adapters/`. It now
serves an adapter that is not OpenAI-shaped, and its current home would make
the Anthropic adapter import from the OpenAI one. This is a file move plus
import updates, no logic change.

## 4. `max_tokens`

The Messages API requires `max_tokens`; Chat Completions does not, and clients
routinely omit it. `Candidate` gains:

```ts
/** The model's known output ceiling, or null when the catalog has none.
 *  Only the Anthropic adapter reads it, because only its dialect requires
 *  a limit to be stated. */
maxOutputTokens: number | null
```

Both branches of `resolve.ts` already select the `catalog_models` row, so the
value costs no new query — `findVirtualModel` reads it off the same LEFT JOIN
that supplies the flavor, and a target naming an uncatalogued model gets
`null`. `execute.ts` passes it to the adapter alongside the path overrides.

The translator resolves `max_completion_tokens ?? max_tokens ?? ceiling ??
4096`. The constant is a floor of last resort for a model nobody catalogued;
the fix for a model that needs more is to fill in its catalog value, not to
raise the constant.

## 5. `src/lib/translate/chat-to-anthropic.ts`

A pure module beside `chat-to-gemini.ts` — no client, no `server-only` — so
every rule below is testable without a network. It exports
`toMessagesRequest`, `fromMessage`, `fromMessageStream` and `droppedParams`.

```ts
export function toMessagesRequest(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config: ProviderConfig,
  maxOutputTokens: number | null,
): Anthropic.MessageCreateParams
```

### Request

`system` and `developer` messages hoist to the top-level `system` parameter.
Hoisting rather than carrying them as a user turn preserves the authority the
client gave the text, the same decision `chat-to-gemini.ts` records.

User and assistant turns map straight across. Unlike Gemini, no alternation
merging is needed: the Messages API accepts consecutive same-role messages and
combines them itself.

Content parts map as: `text` → a text block; `image_url` → an image block with
`source.type: 'url'` for an http URL and `source.type: 'base64'` for a `data:`
URL, splitting out its media type. An assistant's `tool_calls` become
`tool_use` blocks carrying the id verbatim, with `arguments` parsed from its
JSON string; a `tool` message becomes a user turn of `tool_result` blocks keyed
by `tool_use_id`. No id-to-name bridge is needed here — the bridge
`chat-to-gemini.ts` has to build exists because Gemini names calls by function
name, while Anthropic, like OpenAI, names them by id.

Parameters: `tools` map `{name, description, parameters}` →
`{name, description, input_schema}`; `tool_choice` maps `auto` and `none`
across unchanged, `required` → `{type: 'any'}`, and a named function →
`{type: 'tool', name}`; `parallel_tool_calls: false` →
`tool_choice.disable_parallel_tool_use: true`; `stop` → `stop_sequences`;
`user` → `metadata.user_id`; `temperature` and `top_p` pass through.

### Thinking

Gated exactly as `chat-to-responses.ts` gates reasoning summaries, and for the
reason recorded there — asking a model that does not reason for thoughts is an
upstream error, and the gateway cannot tell which kind of model it is
addressing:

```ts
...(effort || config.requestReasoningSummary
  ? {
      thinking: { type: 'adaptive', display: 'summarized' },
      ...(effort ? { output_config: { effort: toEffort(effort) } } : {}),
    }
  : {})
```

`display: 'summarized'` is required, not decoration: on the current Claude
models the default is `omitted`, which streams thinking blocks whose text is
empty. A gateway that left it out would relay silence.

`toEffort` maps OpenAI's vocabulary onto Anthropic's: `minimal` → `low`, `none`
suppresses thinking entirely (no `thinking` key at all), and every other value
— `low`/`medium`/`high`, and `xhigh`/`max` from a client that already speaks
Anthropic's scale — is forwarded verbatim so the endpoint validates it. That
matches the schema's existing decision to type `reasoning_effort` as a free
string rather than an enum the gateway would have to keep current.

`budget_tokens` is never sent. It is rejected outright by every current Claude
model, and adaptive thinking is what replaced it. An operator pointing this
flavor at a pre-4.6 Claude will see the endpoint's own 400; a per-model
thinking-shape override is deliberately left for whoever actually needs one.

Thinking tokens count against `max_tokens`. With a catalogued ceiling that is
harmless; against the 4096 fallback of §4, thinking can consume most of the
budget. The answer is the same as it is for any uncatalogued model — fill in
the ceiling — not a larger constant.

### Response

Text blocks join into `message.content`. `thinking` blocks join into
`reasoning_content`, the same non-standard field `responses-to-chat.ts` writes
and `chat-to-responses.ts` reads; `redacted_thinking` blocks are opaque and are
skipped. `tool_use` blocks become `tool_calls` with `arguments` re-serialized.

`stop_reason` → `finish_reason`: `end_turn`, `stop_sequence` and `pause_turn` →
`stop`; `max_tokens` → `length`; `tool_use` → `tool_calls`; `refusal` →
`content_filter`.

Usage: `prompt_tokens = input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`, with the cached figure repeated in
`prompt_tokens_details.cached_tokens`; `completion_tokens = output_tokens`.
`completion_tokens_details.reasoning_tokens` is omitted rather than derived:
Anthropic bills thinking inside `output_tokens` and reports no separate count,
so any number the gateway put there would be invented, and it feeds cost
reporting.

### Stream

`message_start` yields the role chunk. `content_block_start` and
`content_block_delta` yield content deltas for `text_delta` and
`reasoning_content` deltas for `thinking_delta`, mirroring
`chat-to-responses.ts`'s handling of `response.reasoning_text.delta`. A
`tool_use` block start plus its `input_json_delta`s yield `tool_calls` deltas
indexed by the block's position. `message_delta` carries `stop_reason` and the
final usage; `message_stop` ends the stream.

`chat.ts`'s `isContentDelta` already counts `reasoning_content` as content, so
time-to-first-token stays honest for a thinking model.

### `droppedParams`

Reports what the crossing cannot express: `n` greater than 1,
`presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`,
`top_logprobs`, `seed`, `response_format`, `service_tier`, and a `tool` message
whose `tool_call_id` never appeared in the conversation.

`service_tier` earns its place on that list: `bodyFor()` injects it when a
target pins a tier, the Messages API has no equivalent, and an operator who
pinned one needs the `x-babellm-dropped-params` header to say it did not cross.

`reasoning_effort` is not on the list — the thinking section above carries it.

## 6. Where a candidate's losses are decided

`chatIngress.droppedFor` and `responsesIngress.droppedFor` are already two
near-parallel conditionals over adapter and flavor. A third flavor makes six
branches that have to be kept in step, and the Gemini-before-flavor ordering
bug the responses ingress documents is exactly the kind of mistake that
duplication produces.

Both call one function instead:

```ts
/** What this candidate cannot express of a Chat Completions request,
 *  whichever ingress the request arrived on. */
export function droppedForChat(candidate: Candidate, req: ChatCompletionRequest): string[]
```

`responsesIngress` keeps its own crossing losses and prepends them, as it does
today. This is a refactor of code the change already has to touch, not
unrelated cleanup.

## 7. The Responses ingress gets thinking for free

Because the crossing is Messages → Chat → Responses, `responses-to-chat.ts`
already turns `reasoning_content` into a `reasoning` output item with a
`summary_text`, and already emits `response.reasoning_summary_text.delta` for
streamed deltas. A Responses client therefore receives Claude's thinking with
no new code, and the double crossing is covered by a test rather than an
assumption (§10).

## 8. Catalog sync

The Anthropic adapter implements `listModels` through the SDK's models
endpoint, on the configured `modelsPath`, so a provider whose own flavor is
`anthropic_messages` can still populate its catalog. Each entry contributes its
id and, where the endpoint reports them, the output cap and context window as
`CatalogFields` — the same thing the Gemini adapter does with what its
discovery returns.

Sync keeps calling `createAdapter(provider)` with no model in hand. A model
pinned to this flavor under a provider that is not is discovered on the
provider's own endpoint, which is correct: listing models is a provider
operation.

## 9. Admin surface and copy

No new dialog and no new screen. The flavor select, the gateway-settings
dialog, and the read-only `Anthropic Messages · from model` badge all render
from `API_FLAVORS`; the gateway settings section stays gated to OpenAI-shaped
adapters. The only additions are the Messages path input that §3's field lists
produce, `setModelGateway` accepting and validating it, and `CatalogListItem`
carrying it so the dialog renders its current state.

Copy that now names two flavors where there are three:

- `FLAVOR_HINT` in `adapters/openai/index.ts` and its counterpart in
  `adapters/openai/responses.ts`, each of which tells an operator which flavor
  to switch to.
- `README.md`'s flavor section and adapter table.

## 10. Testing

The pure module carries the weight, as it does for Gemini: table-driven cases
over `toMessagesRequest` (hoisting, images, tool calls, tool results, tool
choice, thinking gating, the `toEffort` mapping, the `max_tokens` fallback
chain), `fromMessage` (stop reasons, usage arithmetic, thinking to
`reasoning_content`), `fromMessageStream` (text, thinking, and interleaved tool
call deltas; the terminal usage) and `droppedParams`.

Adapter tests use a stub client factory, like the OpenAI and Gemini adapter
tests, and cover the resolved request path and the error mapping.

Integration, against the disposable Postgres on 5434:

- an `anthropic_messages` case in `tests/gateway/mixed-flavor.test.ts`,
  including a chain that fails over between two flavors;
- a case in `tests/gateway/dropped-params.test.ts` for the header a pinned
  `service_tier` produces;
- a case in `tests/contract/openai-client.test.ts` proving the real OpenAI
  client reaches a model on this flavor;
- a Responses-ingress case proving the double crossing serves a request and
  relays thinking as `reasoning_summary_text` events;
- `setModelGateway` validation for `messagesPath`, and the enum value plus the
  new column in the schema test.

## Out of scope

- A client-facing `/v1/messages` ingress. Nothing in this change needs one, and
  adding it would mean translating Messages requests into the OpenAI dialects
  for every other model — the opposite direction, and a design of its own.
- Prompt-cache breakpoints (`cache_control`).
- A bearer-auth toggle for clones that reject `x-api-key`.
- A per-model thinking-shape override for pre-4.6 Claude models.
