# Gemini Adapter — design

The `gemini` adapter type has existed since Phase 1: it is offered by the
provider form, its credentials validate, its models.dev namespace is wired, and
every request to it returns `501 unsupported_operation`. This phase implements
it — Google's Gemini Developer API behind the existing `ProviderAdapter`
contract, with `/v1/chat/completions` still the gateway's only ingress.

## 1. Problem

`createAdapter` throws for two of the four adapter types it offers:

```ts
case 'gemini':
case 'bedrock':
  throw new UnsupportedOperationError(
    `The "${runtime.adapter}" adapter is not available yet.`,
  )
```

Everything upstream of that line already works. A `gemini` provider can be
created, its `{ apiKey }` credential validates, `REGISTRY_NAMESPACE.gemini` is
`'google'`, and `canonicalKeyCandidates` already strips a `models/` prefix so
discovered ids match models.dev. Only the adapter is missing.

The consequence is not merely that Gemini is unavailable. It is that the
routing loop's one degenerate path — `execute` skipping a target whose adapter
cannot be constructed — is currently load-bearing for a configuration the
dashboard actively invites. An admin who adds a Gemini provider gets a target
that is silently skipped in every chain it appears in, and a `501` when it is
the only one.

Google also publishes an OpenAI-compatible endpoint, which an
`openai_compatible` provider can already reach today. That path stays available
and untouched. It is not a substitute: it does not expose thinking levels, its
model list is a subset, and it inherits none of the catalog enrichment the
native `models.list` provides.

## 2. Scope

In scope:

- `createGeminiAdapter`: a `ProviderAdapter` speaking Gemini's
  `generateContent` upstream and Chat Completions downstream.
- `src/lib/translate/chat-to-gemini.ts`: pure translation of a Chat Completions
  request into `GenerateContentParameters`, and of a `GenerateContentResponse`
  and its stream back into a `ChatCompletion` and chunk stream.
- `src/lib/adapters/gemini/media.ts`: resolution of `image_url` parts into
  Gemini `Part`s, including Files API upload of https images.
- Error classification for `ApiError`, so a fatal Gemini `400` does not burn
  the failover chain.
- Model discovery via `models.list()`, feeding the catalog's `discovered`
  layer — the first adapter to populate it with anything.
- Reporting of request parameters Gemini cannot express, through the existing
  `x-babellm-dropped-params` header and request log field.

Out of scope, each by explicit decision:

- **Vertex AI.** Developer API only. Vertex needs service-account OAuth, a
  project and a location — a second credential branch and a token lifecycle,
  which is its own phase. Section 3.1.
- **Bedrock.** Still throws `UnsupportedOperationError`. The tests that pin
  that behaviour move from `gemini` to `bedrock` rather than being deleted.
- **Safety settings.** Google's defaults apply. A blocked response surfaces as
  `finish_reason: content_filter`; no per-provider threshold configuration is
  added. Section 3.7.
- **Embeddings, image generation, audio, caching, batches.** The SDK exposes
  them; `/v1/chat/completions` cannot address them. Discovery still labels
  embedding models so the catalog reports them honestly.
- **`logprobs`.** Gemini can return them, but its `logprobsResult` shape would
  need its own translator to reach Chat Completions' `logprobs` field. Dropped
  and reported.
- **Feeding thoughts back upstream.** `thoughtSignature` is not round-tripped;
  reasoning travels out only, exactly as with the Responses flavor.

## 3. Decisions

### 3.1 The Gemini Developer API, through `@google/genai`

The adapter talks to `generativelanguage.googleapis.com` with an API key, via
the official `@google/genai` SDK (2.17.0) rather than hand-rolled `fetch`.

The SDK earns its dependency here in a way it would not for a second
OpenAI-shaped provider. It carries the full `GenerateContentConfig` type
surface — which is the thing this phase is mostly *about* — it handles the
streaming wire format, and `ApiError` gives a single class to classify. The
cost is a second SDK error taxonomy, which section 3.6 confines to one file.

`vertexai` is left unset, so the SDK targets the Developer API. `httpOptions`
carries the provider's `baseUrl` when one is stored, which costs nothing and
lets a proxy be pointed at; it is not advertised in the UI.

The per-endpoint path overrides (`modelsPath`, `chatCompletionsPath`,
`responsesPath`) do not apply. They describe where an OpenAI-shaped clone hangs
its endpoints, and `AdvancedPathsFields` already renders nothing for `gemini`.

### 3.2 Translation is pure; media resolution is not

`chat-to-gemini.ts` holds no I/O, exactly like `chat-to-responses.ts`, so every
translation test runs with no client and no network.

Media breaks that, because an https image has to be fetched and uploaded before
it can be named in a request. The resolution is a two-pass split:

```
adapter.chat(req, ctx)
  1. media.resolveMedia(req.messages, { client, signal })  ->  Map<url, Part>
  2. translate.toGeminiRequest(req, model, media, config)  ->  params   (pure)
  3. client.models.generateContent(params)
  4. translate.fromGenerateContent(res)                    ->  ChatCompletion
```

The alternative — an `async` `toGeminiRequest` taking an injected uploader —
was rejected because it makes every translation test, including the text-only
ones that are the bulk of them, provide a stub for machinery they do not
exercise.

`resolveMedia` returns a `Map` keyed by the original `image_url.url`. A URL
appearing twice in one request is fetched and uploaded once.

### 3.3 System messages are hoisted, and the hoist is reported

Gemini's `contents` accepts only `user` and `model` roles. There is nowhere to
put a `system` turn, so all `system` and `developer` messages are concatenated
in order into `config.systemInstruction`.

This is the one place the gateway reorders a conversation. `chat-to-responses`
explicitly refuses to hoist, because the Responses API accepts system turns
inline; Gemini leaves no such choice. The two candidate degradations are
hoisting (preserves the authority the client gave the text, moves it earlier)
and carrying it as a `user` turn (preserves position, lowers authority to the
untrusted channel). Hoisting wins: a system instruction that arrives with less
authority than the client granted it is a silent behaviour change, while
arriving earlier is a visible one.

It is only visible if reported, so a system message that appeared *after* a
non-system message adds `system_message_hoisted` to the dropped-parameter
report. A conversation whose system turns are all leading — the overwhelming
majority — reports nothing, because nothing moved.

### 3.4 Tool results are correlated by name, through the request

A Chat Completions `tool` message identifies its call by `tool_call_id`.
Gemini's `functionResponse` identifies it by function *name*. Nothing in the
message itself bridges those.

The translator builds the bridge from the conversation it is already walking:
every assistant turn's `tool_calls` contributes `id -> function.name`, and a
later `tool` message resolves its name from that map. This works because the
ids in a well-formed conversation are the ones the gateway itself emitted on
the previous turn.

When resolution fails — no `tool_call_id`, or an id matching no prior call —
the result is carried as a `user` turn reading `[tool result] <text>` and
reported as `unmatched_tool_call_id`. This follows `chat-to-responses`'s rule:
never emit a correlation identifier that refers to nothing. `user` rather than
a system-ish channel for the same reason given there — a tool result is
third-party data, and prompt-injected content must not be handed authority the
original request never granted it.

The legacy `function` role is *better* served than it is by the Responses
translator, which has to degrade it to text: a `function` message carries
`name` directly, which is exactly what Gemini wants. It maps to a real
`functionResponse` and reports nothing. This resolves the Phase 1 handoff note
that `role: "function"` must be translated like `tool`.

`functionResponse.response` must be an object. A tool result that parses as a
JSON object is used as-is; anything else is wrapped as `{ output: <text> }`.

### 3.5 Parameter mapping

Gemini's `GenerateContentConfig` covers more of Chat Completions than the
Responses API does, so the dropped list is short.

| Chat Completions | Gemini |
|---|---|
| `max_completion_tokens` ?? `max_tokens` | `maxOutputTokens` |
| `temperature` | `temperature` |
| `top_p` | `topP` |
| `seed` | `seed` |
| `stop` (string or array) | `stopSequences` |
| `frequency_penalty` | `frequencyPenalty` |
| `presence_penalty` | `presencePenalty` |
| `n` when > 1 | `candidateCount` |
| `tools[].function` | `tools[0].functionDeclarations[]` |
| `tool_choice` | `toolConfig.functionCallingConfig` |
| `response_format` | `responseMimeType` (+ `responseJsonSchema`) |
| `reasoning_effort` | `thinkingConfig` |

Three of those carry a decision:

**`n` is passed only when greater than 1.** Not every Gemini model accepts
`candidateCount`, and a rejected request is fatal — it fails the whole chain
rather than moving on. Since `n: 1` and `n` absent mean the same thing, the
common case is sent as nothing at all and can never trip that. A client that
genuinely asks for `n: 3` gets `candidateCount: 3` and, if the model refuses,
an honest error about a thing it actually asked for.

**Tool parameters pass through verbatim** as `parametersJsonSchema`, which
accepts JSON Schema directly. The alternative field, `parameters`, takes
Gemini's own `Schema` type and would need a converter — a translation layer
inside a translation layer, with its own drift surface.

**`tool_choice`** maps `none`→`NONE`, `auto`→`AUTO`, `required`→`ANY`, and a
named function→`ANY` with `allowedFunctionNames: [name]`.

Dropped and reported: `logit_bias`, `logprobs`, `top_logprobs`,
`parallel_tool_calls`, `user`, non-text non-image content parts, and a
`reasoning_effort` value outside the four known levels.

The inert-value rule from `chat-to-responses` applies here too: a framework
that sends `logprobs: false` or `logit_bias: {}` meaning nothing by it must not
put a line in the header. That module's `isInert` is duplicated into this one
rather than extracted into a shared helper. The two translators drop different
parameter sets for different reasons, and a shared version would have to be
parameterised by both — which couples them harder than the twenty lines it
saves.

### 3.6 Thinking maps to `reasoning_effort` in both directions

`ThinkingLevel` is `MINIMAL | LOW | MEDIUM | HIGH`, which is `reasoning_effort`
with different capitalisation. The mapping is direct, and `includeThoughts` is
requested when the client sent an effort — or when the provider's
`requestReasoningSummary` config flag is set, the same opt-in the Responses
flavor already defines for the same purpose.

The asymmetry with the Responses adapter is worth stating: there, sending
`reasoning` to a non-reasoning model is an upstream error, which is why the
flag exists. Gemini tolerates `thinkingConfig` more gracefully, but the flag is
honoured anyway so one provider setting means one thing across adapters.

Thought parts (`part.thought === true`) come back as `reasoning_content`, the
non-standard field DeepSeek, vLLM and OpenRouter established and real clients
render — the same choice, for the same reason, as `chat-to-responses`.

### 3.7 Response translation

Each `candidate` becomes one `choice`, indexed by `candidate.index` where
Gemini reports one and by array position where it does not. Parts
split three ways: text with `thought !== true` into `content`, text with
`thought === true` into `reasoning_content`, and `functionCall` into
`tool_calls`.

`functionCall.id` is optional in the Gemini API. A missing one is synthesized
as `call_<n>`. Synthesizing is safe here in a way it is not in section 3.4,
because these ids are the gateway's own output: the client echoes one back as a
`tool_call_id`, and the next turn resolves it through the id→name map built
from the assistant message the gateway itself produced.

Finish reasons:

| Gemini | Chat Completions |
|---|---|
| `STOP` | `stop`, or `tool_calls` when calls are present |
| `MAX_TOKENS` | `length` |
| `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`, `RECITATION` | `content_filter` |
| anything else | `stop` |

A request Google refuses outright returns no candidates and a
`promptFeedback.blockReason`. That becomes one empty choice with
`finish_reason: content_filter` rather than a thrown error, so a filtered
prompt reads to the client the way OpenAI's own filter does — and, critically,
does not fail over to another provider that would filter it too.

Usage needs one correction rather than a rename. OpenAI's `completion_tokens`
includes reasoning tokens; Gemini's `candidatesTokenCount` does not:

```
prompt_tokens     = promptTokenCount
completion_tokens = candidatesTokenCount + thoughtsTokenCount
total_tokens      = totalTokenCount
completion_tokens_details.reasoning_tokens = thoughtsTokenCount
prompt_tokens_details.cached_tokens        = cachedContentTokenCount
```

Getting this wrong would under-report completion tokens on every thinking
request, and Phase 4 computes cost from these numbers.

### 3.8 Stream translation

Gemini streams whole `GenerateContentResponse` objects with partial candidates
rather than semantic events, which makes this translator substantially smaller
than `fromResponseStream` — there is no `output_index`-to-`tool_calls[].index`
map to maintain, because a `functionCall` part arrives complete in one chunk.

- Text and thought parts become `content` / `reasoning_content` deltas.
- A `functionCall` part emits one complete `tool_calls` fragment, with
  `arguments` already stringified and the index assigned in arrival order.
- The assistant role rides the first chunk carrying real content, not the
  first chunk of any kind. `startChatStream` pulls one chunk eagerly to decide
  whether to commit the response, and that pull has to mean "the upstream
  produced something" for failover and `ttftMs` to measure what they claim.
- `finish_reason` is emitted when a candidate reports one.
- With `n > 1`, a chunk's candidate index is the chunk's choice index, so the
  streams stay separated the way a Chat Completions client expects. Tool-call
  indices are counted per choice, not globally.
- Usage rides a final choices-empty chunk unless `stream_options.include_usage`
  is `false`. Gemini always reports `usageMetadata`, so as with Responses there
  is no upstream parameter — only an opt-out honoured locally.

### 3.9 Errors

`adapters/gemini/errors.ts` is the Gemini counterpart to
`adapters/openai/errors.ts`, and exists for the reason that file's comment
gives: only the adapter knows which of its provider's statuses are worth
retrying.

`ApiError` carries `status`. Retryable is `408`, `409`, `429`, anything `>=
500`, and an absent status. Everything else is fatal — a Gemini `400` is a
malformed request that every other provider would also reject, and the Phase 1
handoff called out precisely this case as the thing that would otherwise burn a
whole failover chain.

Aborts become `504 upstream_timeout`, checked against both `DOMException` and
`Error` because `DOMException` does not extend `Error` on every runtime.

A `404` gets a hint, mirroring the flavor hints: Gemini model ids look like
`gemini-2.5-flash`, and a stale or prefixed id is the likeliest cause.

### 3.10 Discovery, and the first non-empty `discovered` layer

`models.list()` returns a `Pager<Model>` that iterates like the OpenAI one, but
unlike `/v1/models` it reports facts the catalog wants:

| Gemini `Model` | `CatalogFields` |
|---|---|
| `inputTokenLimit` | `contextWindow` |
| `outputTokenLimit` | `maxOutputTokens` |
| `supportedActions` includes `streamGenerateContent` | `supportsStreaming` |
| `supportedActions` includes `generateContent` | `kind: 'chat'` |
| `supportedActions` includes `embedContent` (and not `generateContent`) | `kind: 'embedding'` |

Every other field stays absent, which the merge layer reads as "this layer does
not know" rather than as a null. Nothing else in the catalog changes: the
`discovered` layer already sits above `registry` and `seed` in `merge.ts`, and
this is simply the first adapter to put anything in it.

Ids are stored with the `models/` prefix stripped, so direct addressing reads
`google/gemini-2.5-flash` rather than `google/models/gemini-2.5-flash`. The SDK
accepts both forms as a model parameter, and `canonicalKeyCandidates` already
tries both when matching against models.dev, so a hand-entered prefixed id
keeps working.

### 3.11 Media resolution

Chat Completions carries images as `image_url`, which may be a `data:` URI or
an ordinary URL. Gemini accepts inline base64 or a file URI — never an
arbitrary web URL. Three cases:

1. **`data:` URI** → decoded to `inlineData` with its declared mime type. No
   network.
2. **A Files API URI or `gs://` URI** → passed through as `fileData`. No
   network.
3. **Any other https URL** → fetched, then uploaded via `ai.files.upload`, and
   referenced as `fileData`.

Case 3 means the gateway makes an outbound request to a URL a caller chose.
That is a deliberate, requested trade: it is what makes ordinary OpenAI clients
work unmodified against a Gemini provider. It is bounded by

- a byte cap on the response, default 20 MB, enforced while reading rather
  than trusting `Content-Length`,
- the attempt's `AbortSignal`, so it cannot outlive the request timeout,
- a `Content-Type` check that the response is actually an image, and
- per-request deduplication by URL.

It is not bounded by a host allowlist, and the README's limitations section
says so plainly: a caller who can reach the gateway can make it issue a GET to
any URL it can route to. An allowlist is the obvious follow-up if this is ever
exposed to untrusted callers.

A failed fetch or upload drops that one part and reports `image_fetch_failed`
rather than failing the request — the same compatibility stance the whole
translation layer is built on. Uploaded files expire on Google's own 48-hour
schedule; the gateway does not delete them, because a delete racing a
still-running generation would break it.

### 3.12 Dropped-parameter reporting dispatches on adapter

`chat-handler.ts` currently decides what was dropped from the API flavor alone:

```ts
return resolveApiFlavor(candidate.provider) === 'responses' ? droppedParams(body) : []
```

It becomes a dispatch on the adapter type first, then flavor. `gemini` has no
flavor — the column exists but the adapter ignores it, and the UI already hides
the selector for it.

The comment above that function stays true and stays there: this is computed in
the handler rather than returned by the adapter, because the alternative is a
channel through `ProviderAdapter` that puts translation-specific knowledge into
the interface every future adapter implements.

## 4. Module layout

```
src/lib/adapters/gemini/
  index.ts    createGeminiAdapter — chat, chatStream, listModels
  client.ts   GoogleGenAI construction, listModels -> DiscoveredModel[]
  errors.ts   ApiError -> ProviderError
  media.ts    resolveMedia(messages, deps) -> Map<url, Part>
src/lib/translate/
  chat-to-gemini.ts   toGeminiRequest / fromGenerateContent /
                      fromGenerateContentStream / droppedParams
```

`client.ts` mirrors `adapters/openai/client.ts` — construction plus discovery,
shared by nothing today but symmetric with the file the reader already knows.
It exports a `GeminiClientFactory` type so tests inject a fake client, the way
`OpenAIClientFactory` is injected today.

## 5. Testing

Unit, no network:

- `tests/lib/translate/chat-to-gemini.test.ts` — request translation: system
  hoisting and its report, tool-result correlation and both failure modes, the
  legacy `function` role, argument parse failure, adjacent same-role merging,
  each parameter in the section 3.5 table, thinking levels, `n` at 1 and 3.
- Response translation: parts split three ways, synthesized call ids, every
  finish-reason row, the no-candidates block, and the usage arithmetic.
- Stream translation: role placement on the first content chunk, tool-call
  fragments, finish reason, usage chunk and its opt-out.
- `tests/lib/adapters/gemini/errors.test.ts` — the retryable/fatal split, the
  abort case, the 404 hint.
- `tests/lib/adapters/gemini/models.test.ts` — field extraction, `models/`
  stripping, embedding-vs-chat classification.
- `tests/lib/adapters/gemini/media.test.ts` — all three cases plus
  deduplication, the byte cap, and fetch failure reporting.

Integration, injected client:

- `tests/lib/adapters/gemini/chat.test.ts` and `stream.test.ts` — the adapter
  wires translation to the client and threads `ctx.signal` into every call.
  That last assertion is a Phase 1 handoff requirement: an adapter that ignores
  the signal holds an upstream connection open past a client disconnect.
- `tests/contract/gemini-client.test.ts` — a real `openai` SDK client against
  the gateway route, backed by a stubbed Gemini client, proving the round trip.

Existing tests that assert Gemini is unimplemented move to `bedrock`:
`tests/lib/adapters/registry.test.ts` (`test.each(['gemini','bedrock'])`) and
`tests/gateway/chat.test.ts`'s 501 case. `tests/gateway/direct-model.test.ts`
seeds a catalog-only `gemini` provider and must not start constructing a real
adapter. `failover.test.ts` and `execute.test.ts` inject their own throwing
`createAdapter` specifically so this phase would not disturb them; they stay as
they are.

## 6. Documentation

- README routing section: the "no adapter yet (`gemini`, `bedrock`)" note
  becomes bedrock-only.
- README limitations: the Gemini line goes; the image-fetch behaviour of
  section 3.11 is added.
- A Gemini section covering what translates, what is dropped, the system-hoist
  behaviour, and thinking support.

## 7. What this does not change

`ProviderAdapter` gains no method and no field. `execute`'s skip-on-construction
path stays exactly as it is — it is still right for `bedrock`, and for a Gemini
provider whose credentials have gone missing. The catalog's merge order,
`resolve`, `select`, the SSE layer and the request log are untouched. One
`switch` case, one dispatch in `chat-handler`, one dependency, five new source
files.
