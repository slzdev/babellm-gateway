# Audio transcriptions (OpenAI-compatible) — design

The gateway serves two ingresses today, `/v1/chat/completions` and
`/v1/responses`, and both carry a JSON body describing a text generation. This
phase adds `POST /v1/audio/transcriptions`: a third ingress whose body is
`multipart/form-data`, whose payload is an audio file, and whose response is
not always JSON.

It is the first endpoint that is not a chat, so it is the first one that tests
whether `runGatewayRequest`'s lifecycle — auth, tags, limits, routing,
failover, breaker, pricing, logging — is actually shape-agnostic, or only
JSON-chat-agnostic.

## 1. Problem

Every OpenAI client that transcribes audio calls
`client.audio.transcriptions.create()`. Against this gateway that is a 404, and
there is no way to reach it: the endpoint is not a flavor of chat, so no
existing ingress can be pointed at it and no `api_flavor` setting exposes it.

The consequences are the ones that make a compatibility gateway lose its point:

**A team cannot put the gateway in front of its whole OpenAI usage.** An app
that both chats and transcribes has to keep a second, direct OpenAI client with
a real provider key next to its gateway client — which is exactly the
credential the gateway exists to keep out of application config.

**Transcription spend is invisible.** The dashboard's premise is that every
request through the gateway is logged with its cost, latency, and attempt
chain. Audio spend that bypasses the gateway is spend nobody can attribute to
a virtual key, a budget, or a tag.

**Whisper-compatible providers cannot be routed to.** Groq, Fireworks, and any
`openai_compatible` clone serving `/audio/transcriptions` are configurable in
the dashboard, pass credential validation, and sync their catalogs — `GET
/v1/models` lists `whisper-large-v3` like any other model — and then 404 on
every transcription. Failover between two Whisper providers is precisely the
kind of thing a virtual model should express.

## 2. Scope

In scope:

- `POST /v1/audio/transcriptions`, non-streaming, all five response formats
  (`json`, `verbose_json`, `text`, `srt`, `vtt`).
- `transcribe` on `ProviderAdapter`, native on the OpenAI-shaped adapters.
- Gemini targets, via a new pure translator that inlines the audio into
  `generateContent`.
- `audio_transcriptions_path` configurable per provider **and** per catalog
  model, like the other endpoints' paths.
- The routing, failover, breaker, limit, tag, logging and pricing lifecycle,
  reused rather than reimplemented.
- Three additive seams on `Ingress`: reading the body, rendering the response,
  and declaring which candidates can serve the dialect.

Out of scope, each by explicit decision:

- **`stream: true`.** Refused with a 400 rather than silently ignored.
  Section 3.7.
- **`POST /v1/audio/translations` and `/v1/audio/speech`.** Neither is
  implemented and neither gets an explanatory 404; they stay ordinary router
  404s until someone asks for them.
- **`diarized_json` and the diarization parameters**
  (`known_speaker_names`, `known_speaker_references`). One model family serves
  them and the shape is still moving.
- **Per-minute pricing.** Whisper-class models bill by audio duration, which
  the catalog's per-Mtok columns cannot express, so those requests log as
  unpriced. Section 3.8.
- **Gemini's Files API.** Audio reaches Gemini inline or not at all.
  Section 3.6.
- **`verbose_json`, `srt` and `vtt` against a Gemini target.** Refused, not
  degraded. Section 3.6.
- **An `endpoint` column on `request_logs`.** Carried forward from the
  Responses ingress design's section 3.7: the log already names the model and
  the target, and a request whose `model` resolved to a Whisper target is a
  transcription.

**One migration**, additive: a nullable `audio_transcriptions_path` column on
`catalog_models`. Provider-level paths live in the provider's JSON config, so
they need none. Nothing backfills, and a rollback loses only overrides that
could not have existed before.

## 3. Decisions

| Decision | Choice |
|---|---|
| Where it lives | A third `Ingress`, on the shared handler. Section 3.1. |
| Multipart body | `Ingress.read(request)` replaces `Ingress.parse(raw)`. Section 3.2. |
| Non-JSON responses | `Ingress.toResponse(res, headers)`. Section 3.3. |
| Adapter surface | `transcribe` on `ProviderAdapter`; no streaming twin. Section 3.4. |
| Targets that cannot transcribe | Filtered out of the chain, not attempted. Section 3.5. |
| Gemini | Inline audio, `json` and `text` only. Section 3.6. |
| Streaming | Refused with 400. Section 3.7. |
| Duration-billed usage | Logged as unmeasured, priced as null. Section 3.8. |
| Response id | None minted, none rewritten. Section 3.9. |
| Payload capture | File metadata, never audio bytes. Section 3.10. |
| File size | Capped at 25 MB, like OpenAI's own limit. Section 3.11. |
| Endpoint path | Configurable per provider and per model. Section 3.12. |

### 3.1 A third ingress, not a second handler

`runGatewayRequest` owns everything that is not wire format: the request id
that becomes `x-request-id` and the log's partition key, key resolution, tag
parsing, limit checks, model resolution, breaker-aware ordering, the failover
loop, pricing, and the fire-and-forget log write. None of that is specific to
chat, and a transcription request needs all of it.

So transcription is an `Ingress`, and `transcriptions-handler.ts` is the same
three-line wrapper `chat-handler.ts` and `responses-handler.ts` already are.
The alternative — a handler of its own — would duplicate some 250 lines of
bookkeeping whose bugs would then have to be fixed twice, and would give
transcription requests a second, subtly different definition of what gets
logged.

What this costs is three new seams on `Ingress`, sections 3.2, 3.3 and 3.5.
Each is a genuine wire-format difference — which is what `Ingress` is for — and
each is written so the two existing ingresses change by one line or not at all.

### 3.2 Reading the body is part of the wire format

Today the handler reads the body itself:

```ts
const body = ingress.parse(await readJson(request))
```

`readJson` is hardcoded because both existing dialects are JSON. Transcription
is `multipart/form-data`, so the read moves behind the interface:

```ts
read(request: Request): Promise<Req>
```

Chat and Responses implement it as `parseWith(schema, await readJson(request))`
— `readJson` and `parseWith` stay exported, so their error envelopes
(`invalid_json`, and `invalid_request` naming the offending `param`) are
unchanged. The transcription ingress reads `request.formData()` instead, and
normalizes the parts before validation: form values arrive as strings, so
`temperature` is `"0.2"`, `stream` is `"true"`, and `timestamp_granularities[]`
may repeat. Coercion belongs in the schema (`z.coerce.number()`, an explicit
`"true" | "false"` enum), not spread across the adapters.

A `read` hook rather than a second `readBody` hook beside the existing `parse`:
one seam is what the interface documents ("everything the wire format decides
lives here"), and two would leave `parse` on the interface being called by
nobody but its own ingress.

**Failover survives this.** `execute` may call an adapter more than once with
the same body, so a re-readable payload is a hard requirement. The `File` a
`FormData` yields is a `Blob`: reading it produces a fresh stream each time and
consumes nothing. The request stream itself is read exactly once, by
`formData()`, before the first attempt.

### 3.3 Not every response is JSON

The handler ends with `Response.json(completion, { headers })`. That is right
for two of the five response formats. `json` and `verbose_json` are JSON;
`text`, `srt` and `vtt` are not, and an `srt` client handed `"WEBVTT\n\n…"`
wrapped in JSON quotes is broken in a way no amount of leniency fixes.

So rendering moves behind the interface too:

```ts
toResponse(res: Res, headers: HeadersInit): Response
```

Chat and Responses implement it as `Response.json(res, { headers })` — the
existing behaviour, spelled once per ingress. The transcription ingress returns
`Response.json` for the two JSON formats and a `text/plain; charset=utf-8`
body for the other three.

`text/plain` for `srt` and `vtt` rather than `application/x-subrip` and
`text/vtt`: it is what the upstream API sends, and the OpenAI SDK decides how
to parse a response by asking whether the content type is `application/json`,
so a more precise type would change nothing for a client while differing from
what that client sees when it talks to OpenAI directly.

The order in the handler is unchanged — `finish`, then build the response, then
log — so a throw while rendering still cannot race a second log line for the
same request id.

### 3.4 `transcribe` on the adapter, with no streaming twin

```ts
transcribe(req: TranscriptionRequest, ctx: AttemptContext): Promise<TranscriptionResult>
```

`TranscriptionResult` is `Transcription | TranscriptionVerbose | string` — the
three shapes the upstream endpoint returns, discriminated by the
`response_format` the ingress already knows it asked for. No wrapper object
carrying the format alongside the body: the ingress chose the format, so a
second copy of it in the return value could only ever disagree with the first.

There is no `transcribeStream`. Section 3.7 refuses streaming, and adding a
method whose only implementation throws would put a lie in the interface.

Who implements it:

| Adapter / flavor | `transcribe` |
|---|---|
| `openai`, `openai_compatible` — `chat_completions` | Native, `POST {audioTranscriptionsPath}`. |
| `openai`, `openai_compatible` — `responses` | The same native implementation. |
| `openai`, `openai_compatible` — `anthropic_messages` | Throws `UnsupportedOperationError`. |
| `gemini` | Translated, section 3.6. |
| `bedrock` | Unreachable; `createAdapter` already throws for it. |

The `responses` row is the interesting one. `api_flavor` says which dialect a
provider's *chat* endpoint speaks; it says nothing about the sibling endpoints
on the same host, and `GET /v1/models` already works the same way regardless of
flavor. A provider whose models are called on `/responses` still serves
`/audio/transcriptions` at the usual place, so both OpenAI-shaped adapters get
`transcribe` from one shared implementation in
`src/lib/adapters/openai/audio.ts`, parameterized by client and path. Writing
it twice would be two chances to diverge on error mapping.

`anthropic_messages` is the honest exception: that flavor's host is Anthropic's
API, which has no transcription endpoint and no audio input at all. The method
exists and throws, because `ProviderAdapter` requires it — but section 3.5
means the throw is unreachable through the gateway.

### 3.5 A target that cannot transcribe is skipped, not attempted

An `anthropic_messages` target inside a virtual model would otherwise burn an
attempt, a breaker failure, and an upstream round trip to learn something the
gateway already knew from its own configuration.

```ts
supports?(candidate: Candidate): boolean
```

Optional on `Ingress`, absent for Chat and Responses (every candidate can serve
those), and implemented by the transcription ingress as "not
`anthropic_messages`". The handler filters the candidate list through it
*before* `selectOrder` runs, and answers 501 `unsupported_operation` naming
the model when nothing remains.

This is deliberately *not* the treatment the Responses ingress gives hosted
tools, which are refused with a 400 rather than failed over. The difference is
what the client asked for. A hosted-tool request cannot be served correctly by
a chat target, so quietly answering it from a later target would be answering a
different question. A transcription is a transcription whichever target
performs it, so preferring one that can is what failover is *for*.

Filtering feeds `selectOrder` rather than following it: `selectOrder`
truncates its ordered chain to `model.maxAttempts`, so a filter applied
downstream of that truncation could throw away a candidate the client's
dialect could actually have used, sitting behind ones it never could —
`maxAttempts: 2` is an operator's promise of two real attempts, not two
candidates chosen before anyone asked whether they could serve. Policy and
breaker demotion still own ordering; only which candidates are eligible to be
ordered at all moves earlier. Filtering still does not move into
`resolveModel`: resolution answers "what does this name route to", which is
the same answer for every endpoint, and a filter there would make the
breaker's open-target bookkeeping depend on which ingress asked.

### 3.6 Gemini transcribes inline, in two formats

`src/lib/translate/transcription-to-gemini.ts`, pure and tested without a
client, like the other translators:

- **Request.** One `user` turn with two parts: `inlineData` carrying the audio's
  base64 and mime type, and a `text` part instructing a verbatim transcription.
  `language` and `prompt` are folded into that instruction — Gemini has no
  fields for them — and `temperature` becomes `config.temperature`.
- **Mime type.** From the uploaded part's own `type` when it is a real audio
  type, else derived from the filename's extension, reusing the extension map
  `gemini-media.ts` already owns. A file whose type cannot be determined is a
  400, not a guess: Gemini rejects an `inlineData` part whose mime type is
  wrong, and a guess would turn a fixable client error into an upstream one.
- **Response.** The candidate's text becomes `{ text }` for `json`, or the bare
  string for `text`.

`verbose_json`, `srt` and `vtt` against a Gemini target are **refused with a
400** naming the target's provider. Gemini returns no timestamps, and all three
formats are timestamps: `srt` and `vtt` are nothing else, and a `verbose_json`
carrying an empty `segments` array and a `duration` the gateway made up would
be a fabricated measurement in a response whose whole purpose is to carry
measurements. The gateway's standing rule is that a number it did not measure
is null, never zero — a `duration` it did not measure is no different.

Consequently `timestamp_granularities` is unreachable for a Gemini target (it
is only valid with `verbose_json`) and needs no drop entry. What is dropped, and
reported in `x-babellm-dropped-params` and the log: `include`, `logprobs`,
`chunking_strategy`, `keywords`, and `languages`.

Inline audio is bounded by Gemini's own request ceiling, so a file that would
exceed roughly 20 MB once base64-encoded is refused with a 400 that names the
limit. The Files API is the upstream answer to larger audio and is out of
scope: it is a stateful two-step upload whose handle outlives the request,
which is a different feature from a stateless proxy hop.

### 3.7 Streaming is refused, not ignored

`stream: true` gets a 400 (`unsupported_parameter`). The upstream API ignores
it for `whisper-1` and honours it for the `gpt-4o-transcribe` family, and the
gateway can do neither honestly: ignoring it leaves a client waiting for
`text/event-stream` holding a JSON body it will not parse, and honouring it
means a third `StreamProtocol`, a transcript accumulator, and a capture shape,
for a dialect whose non-streaming form is one request and one answer.

The 400 says what is unsupported, so a client can drop the flag and retry. When
someone wants it, the SSE relay is already generic over `StreamProtocol<Chunk>`
and this ingress plugs into it the way the other two do.

### 3.8 Tokens price; duration does not

The upstream `usage` object comes in two variants:

- `{ type: 'tokens', input_tokens, output_tokens, … }` — the
  `gpt-4o-transcribe` family. Maps onto `LogUsage` as prompt and completion
  tokens, prices through the existing per-Mtok catalog columns, charges the
  key's tpm and budget counters, and reaches the client as `usage.cost` like
  every other response.
- `{ type: 'duration', seconds }` — `whisper-1` and the Whisper clones. There is
  no token count to record and no per-minute rate in the catalog to price
  against, so `usageOf` returns null: the log row records no usage, and the cost
  is null rather than zero.

That is the established rule — a request that cannot be priced reports
"unpriced", because a dashboard showing $0.00 for real spend is worse than one
showing nothing — and it is why per-minute pricing is a follow-up rather than
something this phase fakes. The gap is documented in the README's limitations,
so an operator routing Whisper traffic knows their dashboard will undercount it
rather than discovering it later.

`seconds` is deliberately not squeezed into `promptTokens`. A duration in a
token column would corrupt every rollup that sums tokens.

### 3.9 No response id

A transcription response has no `id` and no `model` field, so there is nothing
to rewrite and nothing to mint. `Ingress.newIdentityId` becomes optional and
this ingress omits it; `finish` attaches cost and touches nothing else.

The precedent is the Responses ingress's capture record, which omits `id`
rather than stamping a value the client never saw. Fabricating an id here would
be the same mistake with less excuse, since no field would carry it.

### 3.10 Payload capture stores metadata, never audio

For a key with payload logging on, the stored request is the form's fields plus
a description of the file — name, size, mime type — and never its bytes. Audio
is the largest thing that will ever pass through this endpoint and the most
sensitive: a call recording in a Postgres row is a liability the byte cap
reduces but does not remove, and truncated audio has no diagnostic value
anyway. The response side is captured as it is for every other endpoint,
capped by the same `payloadMaxBytes`.

### 3.11 A 25 MB cap, stated by the gateway

The file part is rejected above 25 MB with a 400 naming the limit — the same
ceiling the upstream API enforces, so a request that would fail there fails
here without a round trip, and one that would succeed is not blocked.

Next.js route handlers have no body size limit of their own (only server
actions do), so without this the gateway would happily buffer an arbitrarily
large upload before the provider rejected it.

### 3.12 One more endpoint path, everywhere paths already are

`audioTranscriptions` joins `models`, `chatCompletions`, `responses` and
`messages` in `DEFAULT_PATHS`, `PATH_FIELDS`, `MODEL_PATH_FIELDS` and
`ModelPathOverrides`, with default `/audio/transcriptions`. Because the admin
forms, the server actions and the provider summary all iterate those shared
lists, the provider dialog's Advanced section and the catalog's per-model
gateway dialog pick the field up without a form change — which is the reason
`paths.ts` holds the list in the first place.

The per-model override needs a column, hence the migration. Path resolution,
override layering (`withModelPaths`) and the SDK's absolute-vs-relative rule
are unchanged: the same `resolveRequestPaths` that serves the other four
endpoints serves this one, and `client.audio.transcriptions.create` accepts the
same per-request `path` override the other calls use.

## 4. Wire contract

**Request.** `multipart/form-data`, `Authorization: Bearer sk-bab-…`,
`x-babellm-tags` honoured as everywhere else.

| Field | Handling |
|---|---|
| `file` | Required. 25 MB cap, section 3.11. |
| `model` | Required. A virtual model or `provider/model`, resolved as everywhere else. |
| `response_format` | `json` (default), `verbose_json`, `text`, `srt`, `vtt`. |
| `language`, `prompt`, `temperature` | Forwarded; expressed in the instruction for Gemini. |
| `timestamp_granularities[]` | Forwarded. Requires `verbose_json`, as upstream. |
| `include[]`, `chunking_strategy`, `keywords[]`, `languages[]` | Forwarded to OpenAI-shaped targets; dropped for Gemini and reported. |
| `stream` | `true` is a 400. Section 3.7. |
| `diarized_json`, speaker fields | Out of scope; refused as an unsupported `response_format`. |

**Response.** The upstream body, plus `usage.cost` when there is a `usage`
object to hang it on. Headers are the ones every gateway response carries:
`x-request-id`, `x-babellm-provider`, `x-babellm-upstream-model`,
`x-babellm-dropped-params` when anything was dropped, and the rate-limit
headers.

**Errors.** The gateway's existing envelope and status conventions: 400 for a
bad request, 401 for the key, 404 for an unknown model, 429 for a limit, 501
`unsupported_operation` when no target can transcribe, and the classified
upstream status otherwise.

## 5. Data model

```sql
ALTER TABLE catalog_models ADD COLUMN audio_transcriptions_path text;
```

Nullable, no default, no backfill — "this model names no path", which leaves
the provider's value standing, is exactly what NULL already means for the other
three path columns.

## 6. Failover semantics

Unchanged, and that is the point. The chain is built the same way, minus the
candidates section 3.5 filters out; a retryable upstream failure moves to the
next candidate with the same `File`, re-read; a non-retryable one stops; the
breaker records success and failure per target as always. `x-babellm-provider`
names the target that actually served, and the log's attempt chain records the
ones that did not.

Because the response is committed only after the single upstream call returns,
there is no mid-stream failover question to answer here at all.

## 7. Testing

- **Schema.** Form-value coercion, defaults, the `stream: true` refusal, the
  unknown-`response_format` refusal, the file cap.
- **OpenAI adapter.** Native call shape, the path override (provider and
  model), and error classification, against a stubbed client like the existing
  adapter tests.
- **Gemini translator.** Pure, both directions: mime resolution from type and
  from extension, the instruction built from `language`/`prompt`, the refused
  formats, the inline size ceiling, the dropped-parameter list.
- **Gateway, end to end** through `runGatewayRequest` with a stubbed adapter:
  each of the five formats and its content type, `usage.cost` for token-billed
  and its absence for duration-billed, failover, the `anthropic_messages` skip
  and the "no target can transcribe" 501, limits, tags, the log row, and
  payload capture proving the audio bytes are absent.
- **Contract.** The real OpenAI SDK's `audio.transcriptions.create` driven
  against the gateway over an in-process fetch, as `tests/contract` already
  does for both other ingresses — the test that would catch a multipart detail
  the hand-built requests miss.
- **Regression.** The existing 1371 tests, unchanged. The `Ingress` changes are
  additive or one-line, and any behaviour change to chat or Responses is a bug.

## 8. Documentation

README: the endpoint in the intro and the diagram, what it supports, and the
limitations that are decisions — no streaming, no `verbose_json`/`srt`/`vtt`
from a Gemini target, and duration-billed models logging as unpriced.

## 9. Follow-ups this deliberately leaves

- Per-minute pricing, which would make Whisper spend visible (section 3.8).
- Streaming transcription (section 3.7).
- `/v1/audio/translations`, the same shape with a fixed target language.
- `/v1/audio/speech`, which is the reverse direction and a different problem:
  the response is the payload.
