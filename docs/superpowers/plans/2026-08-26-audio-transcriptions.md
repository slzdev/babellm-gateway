# Audio transcriptions (OpenAI-compatible) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `POST /v1/audio/transcriptions` for any OpenAI client, against OpenAI-shaped and Gemini targets, with the same routing, failover, breaker, limit, tag, logging and pricing lifecycle every other endpoint gets.

**Architecture:** A third `Ingress` on the existing shared handler. Three additive seams make that possible: `read` (the body is multipart, not JSON), `toResponse` (three of the five response formats are not JSON), and `supports` (an `anthropic_messages` target cannot transcribe and is filtered out of the chain rather than attempted). `transcribe` joins `ProviderAdapter`, native for both OpenAI-shaped flavors from one shared implementation, translated for Gemini by a new pure module.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, Postgres, Vitest, OpenAI SDK, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-08-26-audio-transcriptions-design.md`

## Global Constraints

- **Test database:** this worktree's `.env.test` points at `babellm_test_audio` on **port 5434**. Never repoint it at 5432 — that is the developer's own database. Never run `pnpm test:db:down`: the compose project is shared, so it destroys sibling worktrees' containers mid-run. The container is already running.
- **Run tests with:** `pnpm test` (full) or `pnpm vitest run <path>` (single file). `pnpm typecheck` and `pnpm lint` before declaring a task done.
- **Baseline:** 116 files, 1371 tests, green at `c3f6b26`. Chat and Responses behaviour must not change; a diff in their tests is a bug in this work, not a test to update.
- **No fabricated measurements.** A duration-billed transcription has no token counts, so it logs no usage and prices as `null` — never `0`, never `seconds` in a token field.
- **Audio bytes never reach the log.** Payload capture stores the file's name, size and mime type.
- **The `File` is re-read, never consumed.** `execute` may call an adapter more than once with the same request; anything that turns the `File` into a one-shot stream breaks failover.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `test:`, `refactor:`, `docs:`), matching the existing history.

---

## Phase 1 — Seams

### Task 1: Widen `Ingress` and the handler

Pure refactor plus three unused hooks. The two existing ingresses keep their behaviour exactly; the point of doing this first is that Task 7 then writes an ingress against a finished interface.

**Files:**
- Modify: `src/lib/gateway/handler.ts`, `src/lib/gateway/protocols/chat.ts`, `src/lib/gateway/protocols/responses.ts`
- Test: `tests/lib/gateway/ingress-seams.test.ts` (new), plus the whole existing suite as the regression check

**Interfaces:**

```ts
export interface Ingress<Req, Res, Chunk> {
  /** Reads AND validates the body. Replaces `parse(raw: unknown)`: the wire
   *  format decides how the body arrives, not just what it contains. */
  read(request: Request): Promise<Req>
  modelOf(req: Req): string
  isStream(req: Req): boolean
  droppedFor(candidate: Candidate, req: Req): string[]
  run(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): Promise<Res>
  finish(res: Res, identity: IdentityOptions, cost: CostPayload | null): Res
  usageOf(res: Res): LogUsage | null
  /** Renders the finished result. Both JSON dialects pass `Response.json`. */
  toResponse(res: Res, headers: HeadersInit): Response
  /** Which candidates can serve this dialect. Absent means "all of them". */
  supports?(candidate: Candidate): boolean
  /** Absent for a dialect with no response id of its own. */
  newIdentityId?(): string
  /** The four streaming members, absent for a dialect this gateway does not
   *  stream. Reachable only when `isStream()` returns true. */
  runStream?(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): AsyncIterable<Chunk>
  stream?: StreamProtocol<Chunk>
  captureResponse?(identity: IdentityOptions, capture: StreamCapture, outcome: StreamOutcome): unknown
}
```

Handler changes, all inside `runGatewayRequest`:

1. `const body = await ingress.read(request)` replaces `ingress.parse(await readJson(request))`. Keep `readJson` and `parseWith` exported — the two JSON ingresses call them, and their error envelopes must not change.
2. `identity` becomes `{ id: ingress.newIdentityId?.() ?? '', model: modelName }`. Document that `''` means "this dialect has no response id"; nothing reads it in that case.
3. After `selectOrder`, filter the chain:

```ts
const chain = ingress.supports
  ? selectOrder(candidates, model, { open }).filter(ingress.supports)
  : selectOrder(candidates, model, { open })

if (chain.length === 0) {
  throw new GatewayError({
    status: 501,
    type: 'invalid_request_error',
    code: 'unsupported_operation',
    message: `No target of \`${modelName}\` can serve this endpoint.`,
  })
}
```

  Filter after selection, not before: `selectOrder` owns policy and breaker demotion, and a filter upstream of it would change which target a weighted or round-robin model picks for *other* endpoints.

4. The streaming branch asserts its four members are present before use — one narrow helper, throwing an internal `GatewayError` (500, `internal_error`) if not. Unreachable in practice: an ingress with no streaming members refuses `stream: true` in `read`.
5. The buffered branch's `Response.json(completion, { headers })` becomes `ingress.toResponse(completion, headers)`. The order stays `finish` → build response → `log`, so a throw while rendering cannot race a second log line for one request id.

**Chat and Responses:** add `read` (wrapping their existing schema parse) and `toResponse` (`Response.json`). `parse` is removed from both, along with the field on the interface. Nothing else moves.

- [ ] **Step 1: Write the failing tests**

`tests/lib/gateway/ingress-seams.test.ts` drives `runGatewayRequest` with a minimal fake ingress (a seeded key and model from `tests/helpers/gateway.ts`, a stubbed `createAdapter`), proving:

- `read` receives the real `Request` — a fake ingress that reads `request.headers.get('content-type')` sees the caller's value, so the hook is not handed a pre-parsed body.
- `toResponse` decides the response: an ingress returning `new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } })` produces exactly that content type, and the attempt headers are still merged in.
- `supports` filters: two seeded targets, a `supports` that rejects the first, and the served provider is the second — with the log's attempt chain showing **one** attempt, proving the rejected target was skipped rather than tried and failed.
- `supports` rejecting everything answers 501 `unsupported_operation` with no upstream call.
- An ingress with no `newIdentityId` still serves a buffered response.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm test`. All 1371 pre-existing tests pass **unchanged**; the new file passes. `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `refactor(gateway): widen the ingress seam for non-JSON dialects`

---

### Task 2: `audioTranscriptions` path plumbing

The fifth endpoint path, wherever the other four already are. No transcription code yet — this task is finished when a provider and a catalog model can *hold* the override.

**Files:**
- Modify: `src/lib/adapters/paths.ts`, `src/lib/adapters/types.ts`, `src/lib/adapters/registry.ts`, `src/lib/db/schema.ts`, `src/lib/gateway/resolve.ts`, `src/lib/admin/catalog.ts`, `src/app/(admin)/catalog/actions.ts`
- Create: `drizzle/0011_*.sql` (via `pnpm db:generate`)
- Test: extend `tests/lib/adapters/paths.test.ts`, `tests/lib/adapters/registry.test.ts`, `tests/lib/gateway/resolve.test.ts`, `tests/lib/db/schema.test.ts`, `tests/lib/admin/catalog.test.ts`

**Interfaces:**
- `DEFAULT_PATHS.audioTranscriptions = '/audio/transcriptions'`; `CONFIG_KEYS.audioTranscriptions = 'audioTranscriptionsPath'`.
- One entry each in `PATH_FIELDS` ("Audio transcriptions path", help: where this provider transcribes audio) and `MODEL_PATH_FIELDS` (help: where this one model is transcribed, if not where the provider serves the rest).
- `ProviderConfig.audioTranscriptionsPath?: string`; `ModelPathOverrides.audioTranscriptionsPath?: string | null`.
- `resolveProviderPaths` / `resolveRequestPaths` gain the key; `withModelPaths` in `registry.ts` copies it and keeps its "a set key wins, an unset one falls through to the provider" rule; `modelPaths()` in `resolve.ts` reads the new column.
- `catalogModels.audioTranscriptionsPath = text('audio_transcriptions_path')`, nullable.

The admin forms need **no** change: `advanced-paths-fields.tsx` and `catalog-forms.tsx` both iterate the shared lists, and `providers/actions.ts` and `lib/admin/providers.ts` iterate `PATH_FIELDS`. What does need changing is the catalog row's projection (`lib/admin/catalog.ts`) and the per-model gateway action (`catalog/actions.ts`), which name the three path columns explicitly.

- [ ] **Step 1: Write the failing tests** — the new key resolving to its default, a provider override going absolute against the base URL's origin, a model override layering over a provider's, a blank clearing it, the column round-tripping, and the catalog projection exposing it so the dialog's placeholder inherits the provider's value.

- [ ] **Step 2: Implement.** Generate the migration with `pnpm db:generate` — do not hand-write the SQL file or the journal.

- [ ] **Step 3: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`. Confirm the generated migration is `ALTER TABLE ... ADD COLUMN` only.

- [ ] **Step 4: Commit** — `feat(adapters): make the audio transcriptions path configurable`

---

## Phase 2 — The dialect

### Task 3: The request schema

**Files:**
- Create: `src/lib/schemas/transcription.ts`
- Test: `tests/lib/schemas/transcription.test.ts`

**Interfaces:**

```ts
export const TRANSCRIPTION_FORMATS = ['json', 'verbose_json', 'text', 'srt', 'vtt'] as const
export type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number]
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export interface TranscriptionRequest {
  file: File
  model: string
  response_format: TranscriptionFormat   // defaulted to 'json'
  language?: string
  prompt?: string
  temperature?: number
  timestamp_granularities?: ('word' | 'segment')[]
  include?: string[]
  languages?: string[]
  keywords?: string[]
  chunking_strategy?: 'auto' | Record<string, unknown>
}

/** FormData → the plain object the schema validates. */
export function transcriptionFromForm(form: FormData): unknown
export const transcriptionRequestSchema: z.ZodType<TranscriptionRequest>
```

Rules the schema and normalizer encode:

- `file` must be a `File`; a string value for it is a 400 naming `file`.
- Over `MAX_FILE_BYTES` is a 400 whose message names the limit in MB.
- Repeated parts (`timestamp_granularities[]`, `include[]`, `languages[]`, `keywords[]`) collapse to arrays; the trailing `[]` in a key is stripped, since that is how every HTTP client spells a repeated field.
- Numbers and booleans arrive as strings: `temperature` through `z.coerce.number()` bounded 0–1, `stream` through an explicit `'true' | 'false'` enum.
- `stream: 'true'` is refused: 400, `code: 'unsupported_parameter'`, `param: 'stream'`, message saying streaming transcription is not served and to retry without the flag.
- `response_format` outside the five is refused naming the five — which is also how `diarized_json` gets its answer.
- `timestamp_granularities` without `response_format: 'verbose_json'` is refused naming both fields, as upstream does.
- `chunking_strategy` is `'auto'` or a JSON object; a non-`auto` string that will not parse as JSON is a 400.
- Unknown fields pass through, matching the `looseObject` convention in `schemas/chat.ts`.

Errors are raised as `GatewayError` from `parseWith`'s envelope where the shape allows, so a client sees the same error body every other endpoint produces.

- [ ] **Step 1: Write the failing tests** — every rule above, plus: defaults applied when only `file` and `model` are given; a 24 MB file accepted and a 26 MB one refused (build them with `new File([new Uint8Array(n)], …)`, no fixture on disk); `temperature: '0.2'` becoming `0.2`; two `timestamp_granularities[]` parts becoming `['word','segment']`.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm vitest run tests/lib/schemas/transcription.test.ts`, then `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(schemas): validate audio transcription requests`

---

### Task 4: `transcribe` on the OpenAI-shaped adapters

**Files:**
- Create: `src/lib/adapters/openai/audio.ts`
- Modify: `src/lib/adapters/types.ts`, `src/lib/adapters/openai/index.ts`, `src/lib/adapters/openai/responses.ts`, `src/lib/adapters/wrappers.ts`, `src/lib/adapters/registry.ts`
- Test: `tests/lib/adapters/openai/transcription.test.ts`, extend `tests/lib/adapters/registry.test.ts`

**Interfaces:**

```ts
// types.ts
export type Transcription = OpenAI.Audio.Transcription
export type TranscriptionVerbose = OpenAI.Audio.TranscriptionVerbose
export type TranscriptionResult = Transcription | TranscriptionVerbose | string

export interface ProviderAdapter {
  // …existing members…
  transcribe(req: TranscriptionRequest, ctx: AttemptContext): Promise<TranscriptionResult>
}

// openai/audio.ts
export function transcribeVia(
  client: OpenAI,
  path: string,
): (req: TranscriptionRequest, ctx: AttemptContext) => Promise<TranscriptionResult>
```

`transcribeVia` builds the upstream params — the client's fields with `model` replaced by `ctx.upstreamModel` and `file` passed through — and calls `client.audio.transcriptions.create(params, { signal: ctx.signal, path })`. The SDK merges `{ method, path, ...opts }`, so the per-request `path` overrides the resource's hardcoded `/audio/transcriptions`, exactly as it does for chat completions. Errors go through the adapter's existing `toProviderError` with the same flavor hint, so classification and retryability are unchanged.

Both `createOpenAIAdapter` and `createResponsesAdapter` expose it from `paths.audioTranscriptions` — the endpoint is a sibling on the same host, not a dialect of chat.

`ChatOnlyAdapter` becomes `Omit<ProviderAdapter, 'respond' | 'respondStream' | 'transcribe'>`, and a new `withTranscribeUnsupported(adapter, providerName, reason)` in `wrappers.ts` supplies the method for an adapter that has no transcription endpoint, throwing `UnsupportedOperationError` (501, non-retryable via `classifyProviderError`) with a message naming the provider and why. The registry applies it to the `anthropic_messages` branch. Gemini gets a real implementation in Task 6.

- [ ] **Step 1: Write the failing tests** — against a stubbed client factory, as the sibling adapter tests do: the params sent (upstream model substituted, `file` untouched, `response_format` forwarded); the `signal` and the resolved `path`; a provider-level path override and a model-level one both reaching the call; a 429 classified retryable and a 400 not; and the `anthropic_messages` flavor's `transcribe` throwing `UnsupportedOperationError`.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(openai): call providers on /audio/transcriptions`

---

### Task 5: The Gemini translator

Pure, no client, no I/O — testable on its own, like `chat-to-gemini.ts`.

**Files:**
- Create: `src/lib/translate/transcription-to-gemini.ts`
- Modify: `src/lib/translate/gemini-media.ts` (audio extensions in the mime map, exported for reuse)
- Test: `tests/lib/translate/transcription-to-gemini.test.ts`

**Interfaces:**

```ts
/** Refuses what Gemini cannot answer, before any work is done. Throws a 400
 *  GatewayError naming the provider. */
export function assertTranscribable(req: TranscriptionRequest, providerName: string): void

export async function toGeminiRequest(
  req: TranscriptionRequest,
  model: string,
  config: ProviderConfig,
): Promise<GenerateContentParameters>

export function fromGenerateContent(
  result: GenerateContentResponse,
  req: TranscriptionRequest,
): TranscriptionResult

/** What Gemini cannot express of this request, for x-babellm-dropped-params. */
export function droppedParams(req: TranscriptionRequest): string[]
```

Behaviour:

- `assertTranscribable` refuses `verbose_json`, `srt` and `vtt` with a 400 explaining that the target returns no timestamps, and refuses audio that would exceed `MAX_INLINE_BYTES` (20 MB) with a 400 naming the limit and saying larger audio needs an OpenAI-shaped target. Called before the file is read, so a refused request never base64-encodes 20 MB.
- `toGeminiRequest` is async only because it awaits `req.file.arrayBuffer()`. One `user` turn, `inlineData` first (mime type + base64), then a `text` part: a verbatim-transcription instruction, extended with the language when `language` is set and with the client's `prompt` when present, clearly framed as context rather than as something to transcribe. `temperature` goes to `config.temperature`. The `abortSignal` is added by the adapter, not here.
- Mime type: `req.file.type` when it is an `audio/*` (or `video/*`, since a video container's audio track transcribes fine) type, else derived from the filename extension via the shared map, else a 400 saying the type could not be determined and to send it on the file part.
- `fromGenerateContent` concatenates the candidate's text parts; `{ text }` for `json`, the bare string for `text`. A response with no candidate or no text is a `ProviderError` (502, retryable) — an empty transcription from a provider that returned nothing is not a result worth handing a client.
- `droppedParams` reports whichever of `include`, `chunking_strategy`, `keywords` and `languages` the request actually carried. Never `timestamp_granularities`: it is only legal with `verbose_json`, which `assertTranscribable` has already refused.

- [ ] **Step 1: Write the failing tests** — mime from the part's own type; mime from `.mp3`/`.wav`/`.m4a`/`.ogg`/`.flac`/`.webm` when the type is absent or `application/octet-stream`; the 400 for an undeterminable type; the instruction with and without `language`/`prompt`, and the prompt not being mistaken for content; `temperature` reaching the config; the three refused formats each naming the provider; the inline ceiling refused before encoding; base64 round-tripping a small buffer; `json` vs `text` return shapes; an empty candidate becoming a retryable `ProviderError`; the dropped list.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(translate): transcribe audio through Gemini's generateContent`

---

### Task 6: Gemini adapter `transcribe`

**Files:**
- Modify: `src/lib/adapters/gemini/index.ts`, `src/lib/adapters/registry.ts`
- Test: `tests/lib/adapters/gemini/transcription.test.ts`

A thin wrapper over Task 5, mirroring the adapter's existing `chat`: call `assertTranscribable`, build params, add `ctx.signal` as `config.abortSignal`, call `client.models.generateContent`, map the result, and route every throw through the adapter's `toProviderError`. The registry stops wrapping Gemini in `withTranscribeUnsupported` and uses this instead.

- [ ] **Step 1: Write the failing tests** — the params handed to a stubbed client (model, inline part, abort signal); the mapped result; a refused format surfacing as a 400 `GatewayError` and **not** as a provider error (it is the client's request that is wrong, and it must not be retried against another target); an SDK throw arriving classified.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(gemini): serve audio transcriptions`

---

## Phase 3 — Ingress, route, proof

### Task 7: The transcription ingress

**Files:**
- Create: `src/lib/gateway/protocols/transcription.ts`
- Modify: `src/lib/gateway/usage.ts`
- Test: `tests/lib/gateway/transcription-protocol.test.ts`, extend `tests/lib/gateway/usage.test.ts`

**Interfaces:**

```ts
// usage.ts — the third spelling of the same numbers, beside usageFrom and
// usageFromResponses. Duration-billed usage measures no tokens, so it is null.
export function usageFromTranscription(raw: unknown): LogUsage | null

// protocols/transcription.ts
export const transcriptionIngress: Ingress<TranscriptionRequest, TranscriptionResult, never>
```

Members:

- `read`: `transcriptionRequestSchema` over `transcriptionFromForm(await request.formData())`, with a 400 (`invalid_form`) when the body is not multipart at all — a client that sent JSON here has made a mistake worth naming.
- `modelOf`: `req.model`. `isStream`: always `false` (the schema refuses `stream: true`).
- `supports`: `candidate.apiFlavor !== 'anthropic_messages'`.
- `droppedFor`: the Gemini translator's `droppedParams` for a Gemini candidate, `[]` otherwise — an OpenAI-shaped target is sent the request as it arrived.
- `run`: `adapter.transcribe(req, ctx)`.
- `usageOf`: `usageFromTranscription`, which maps `{type:'tokens'}` onto prompt/completion tokens and returns null for `{type:'duration'}` and for a string result.
- `finish`: `withUsageCost(res, cost)` — which returns a string result untouched, since there is no `usage` to hang cost on, and no identity rewriting happens at all.
- `toResponse`: `Response.json` for `json` and `verbose_json`; `text/plain; charset=utf-8` for `text`, `srt` and `vtt`, with the attempt headers merged in either way. The format comes from the request, so the ingress closes over it — implement this as a factory or read it back off the result's shape, whichever keeps `Ingress` unchanged; do not add a format parameter to the interface.
- No `newIdentityId`, no `runStream`, no `stream`, no `captureResponse`.
- `captureRequest`-shaped helper for payload capture: the form fields plus `{ file: { name, size, type } }`, never the bytes. Payload capture reads `requestBody` in the handler, so this is applied where the ingress builds its request object — the stored request must not contain a `File`.

**Note for the implementer:** the handler stores `requestBody` for payload capture directly. A `File` in that object would be serialized by `capPayload` into something useless at best. Confirm by test that a captured request row contains the metadata and no audio bytes; if the seam does not allow it cleanly, add an optional `captureRequest?(req): unknown` to `Ingress` (defaulting to identity) rather than mutating the request the adapters receive.

- [ ] **Step 1: Write the failing tests** — each member in isolation: the two usage variants and the string case; `supports` for all four flavors; `droppedFor` for Gemini vs OpenAI; the five formats' content types; cost attached for token-billed and absent for duration-billed; the capture shape carrying metadata only.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(gateway): add the audio transcription ingress`

---

### Task 8: The route

**Files:**
- Create: `src/lib/gateway/transcriptions-handler.ts`, `src/app/v1/audio/transcriptions/route.ts`
- Test: covered by Task 9

`transcriptions-handler.ts` is the three-line wrapper its two siblings are. The route exports `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, and `POST`, matching `src/app/v1/chat/completions/route.ts` exactly.

- [ ] **Step 1: Implement** (no test of its own — a three-line delegation, exercised end to end by Task 9)

- [ ] **Step 2: Verify** — `pnpm typecheck`, `pnpm lint`, and `pnpm build` to prove the route is registered.

- [ ] **Step 3: Commit** — `feat(gateway): serve POST /v1/audio/transcriptions`

---

### Task 9: End-to-end gateway tests

The task that proves the lifecycle was reused rather than reimplemented.

**Files:**
- Create: `tests/gateway/transcriptions.test.ts`
- Modify: `tests/helpers/gateway.ts` if a seeding helper is genuinely missing

Drive `handleTranscriptions` with a real multipart `Request` and a stubbed `createAdapter`, and assert:

1. Each of the five formats: status, content type, body.
2. `usage.cost` present and correct for token-billed usage; `usage` untouched and cost absent for duration-billed.
3. `x-request-id`, `x-babellm-provider`, `x-babellm-upstream-model` and the rate-limit headers on a success.
4. Failover: first target throws a retryable error, second serves, response comes from the second, log's attempt chain has two entries — and the **same file content** arrives at the second adapter, which is the failover-safety proof.
5. An `anthropic_messages` target in a two-target model is skipped: one attempt, served by the other.
6. A model whose only target is `anthropic_messages` answers 501 `unsupported_operation`.
7. Limits: an rpm-exhausted key gets 429 before any adapter call.
8. `x-babellm-tags` reaching the log row.
9. The log row: model, status `200`, outcome `ok`, `stream: false`, latency, final target, usage and cost consistent with the response.
10. Payload capture on a logging key: the stored request has the fields and the file's metadata, and — asserted explicitly — no audio bytes anywhere in the row.
11. `stream: 'true'` in the form: 400, no adapter call.
12. A 26 MB file: 400, no adapter call.
13. An unknown model: 404, and a JSON body in the standard error envelope.

Use `tests/helpers/logs.ts` for the log assertions and `resetDb()` between tests, as the sibling gateway tests do.

- [ ] **Step 1: Write the tests** (they should pass — Tasks 1–8 built the behaviour; any failure here is a real defect, so fix the source, not the assertion)

- [ ] **Step 2: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 3: Commit** — `test(gateway): cover the audio transcription endpoint end to end`

---

### Task 10: Contract test with the real SDK

**Files:**
- Modify: `tests/contract/openai-client.test.ts` (or a sibling `transcriptions` contract file if that one grows unwieldy)

Point a real `OpenAI` client at an in-process `fetch` that calls `handleTranscriptions`, and call `client.audio.transcriptions.create({ file, model, response_format })`. This is the test that catches what hand-built multipart requests cannot: the SDK's own boundary, filename and part-ordering choices, and its content-type-driven parsing of the `text`/`srt`/`vtt` responses.

Cover `json`, `verbose_json` and `text` at minimum, and assert the SDK returns a parsed object for the first two and a string for the third.

- [ ] **Step 1: Write the tests**

- [ ] **Step 2: Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 3: Commit** — `test(contract): drive the OpenAI SDK's transcription client through the gateway`

---

### Task 11: Documentation and final verification

**Files:**
- Modify: `README.md`

Add, in the voice the README already uses:

- The endpoint in the intro, with a short `client.audio.transcriptions.create` example beside the `responses.create` one.
- `/v1/audio/transcriptions` in the mermaid diagram's gateway node.
- What it supports: five response formats, any OpenAI-shaped or Gemini target, the same virtual models, failover, budgets and logs.
- The limitations, each as a decision with its reason: no `stream: true`; `verbose_json`/`srt`/`vtt` refused against a Gemini target because it returns no timestamps; duration-billed models (`whisper-1` and clones) logging as **unpriced**, because the catalog has no per-minute rate; the 25 MB cap; no `/v1/audio/translations` or `/v1/audio/speech`.
- The per-provider and per-model `audioTranscriptionsPath` override wherever the other paths are documented.

Then the completion check, per `superpowers:verification-before-completion`:

- [ ] `pnpm test` — full suite green, and the pre-existing 1371 tests still pass
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `git diff main --stat` reviewed: no stray file, no `.env.test`, no change to Chat or Responses behaviour
- [ ] The generated migration is additive and the drizzle journal has exactly one new entry

- [ ] **Commit** — `docs(readme): document the audio transcriptions endpoint`

---

## What "done" means

An OpenAI client pointed at the gateway can transcribe audio against a virtual
model that fails over between two Whisper providers, in any of the five
response formats, with the cost of a token-billed model in `usage.cost` and the
request in the log with its attempt chain — and a Gemini target serves the same
request in `json` or `text`, refusing the timestamp formats rather than
inventing timestamps.
