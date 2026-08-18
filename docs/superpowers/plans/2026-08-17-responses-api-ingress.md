# Responses API (OpenAI-compatible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `POST /v1/responses` as a second OpenAI-compatible ingress, and call providers on `/responses` as well as `/chat/completions`, so both protocols work in both directions.

**Architecture:** Two dialects give four paths, two of which are identity. The two crossing paths are supplied by wrappers applied once in `registry.ts` — `withRespondViaChat` and `withChatViaResponses` — so no adapter carries a per-protocol branch. `ProviderAdapter` grows `respond`/`respondStream`; the flavor that selects the implementation is resolved per route target, inheriting the provider. Both ingresses run through one shared handler core parameterised by an `Ingress` descriptor, so limits, logging, cost, and failover exist once.

**Tech Stack:** Next.js 16 (App Router, `runtime = 'nodejs'`), TypeScript, Zod 4 (`z.looseObject`), Drizzle ORM + Postgres, the `openai` SDK, Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-17-responses-api-ingress-design.md`

## Global Constraints

- **Never point tests or browser checks at port 5432.** Tests read `.env.test`, whose `DATABASE_URL` is `postgres://babellm:babellm@localhost:5434/babellm_test_responses` in this worktree. Browser checks use `pnpm dev:test-db` (port 3001, `babellm_dev` on 5434). Never `pnpm dev`.
- **Never run `pnpm test:db:down`.** The compose project is shared across worktrees; a down destroys sibling worktrees' containers mid-run. The test Postgres is already running.
- **Zod objects are `z.looseObject`**, matching `src/lib/schemas/chat.ts`: unknown keys pass through to the provider rather than being stripped.
- **Enum-ish request fields are typed as free strings**, not zod enums — see the `reasoning_effort` and `service_tier` comments in `src/lib/schemas/chat.ts:92,100`. New tier and effort names appear faster than the schema is updated.
- **Absent token counts stay `null`, never `0`** — "we did not measure it" and "it was free" must not render identically (`src/lib/gateway/usage.ts:14-21`).
- **Adapters throw `ProviderError`, never a raw SDK error.** Only the adapter knows which statuses are worth retrying (`src/lib/gateway/errors.ts:42-47`).
- **Log writes are fire-and-forget.** A request that succeeded must never be failed or slowed by its own bookkeeping.
- **Commit messages** are conventional-commit style and end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: <your session URL>
  ```
- **Run `pnpm typecheck` and `pnpm lint` before each commit.** Both must be clean.
- The full suite baseline is **91 files, 992 tests, 0 failures**. No task may reduce it.

## File Structure

**Created:**
- `src/lib/api-flavors.ts` — `API_FLAVORS` + `ApiFlavor`, mirroring `service-tiers.ts`. Its own module because client components need the list and the schema is server-only.
- `src/lib/gateway/handler.ts` — `Ingress` descriptor + `runGatewayRequest`, the shared lifecycle.
- `src/lib/gateway/protocols/chat.ts` — the Chat `StreamProtocol` and `Ingress`.
- `src/lib/gateway/protocols/responses.ts` — the Responses `StreamProtocol` and `Ingress`.
- `src/lib/schemas/responses.ts` — `responsesRequestSchema`, `ResponsesRequest`.
- `src/lib/translate/responses-to-chat.ts` — the new translator.
- `src/lib/adapters/wrappers.ts` — `withRespondViaChat`, `withChatViaResponses`.
- `src/app/v1/responses/route.ts` — the new ingress.
- `src/app/(admin)/models/api-flavor-select.tsx` — the per-target picker.

**Restored from `23dc469^` (do not rewrite — check out the old blob):**
- `src/lib/translate/chat-to-responses.ts`, `src/lib/adapters/openai/responses.ts`, and their tests.

**Modified:** `src/lib/adapters/types.ts`, `registry.ts`, `openai/paths.ts`, `src/lib/db/schema.ts`, `src/lib/gateway/{chat-handler,sse,identity,usage,resolve,execute}.ts`, `src/lib/admin/models.ts`, the providers and models admin UI, `README.md`.

---

# Phase 1 — Handler core extraction

No Responses code. Pure refactor, suite green throughout. It touches the gateway's hottest path, so it lands alone.

### Task 1: Parameterise the SSE relay

**Files:**
- Modify: `src/lib/gateway/sse.ts`
- Create: `src/lib/gateway/protocols/chat.ts`
- Modify: `src/lib/gateway/chat-handler.ts:305-354`
- Test: `tests/lib/gateway/sse.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `ChatCompletionChunk` from `@/lib/adapters/types`, `IdentityOptions`/`rewriteChunk` from `./identity`, `ClassifiedError` from `./errors`, `LogUsage` from `@/lib/logs/types`.
- Produces:
  ```ts
  // sse.ts
  export interface StreamProtocol<Chunk> {
    frame(chunk: Chunk, identity: IdentityOptions): Uint8Array
    terminator: Uint8Array | null
    errorEvent(err: ClassifiedError): Uint8Array
    accumulate(captured: StreamCapture, chunk: Chunk, maxBytes: number): void
    usageOf(chunk: Chunk): LogUsage | null
    /** True for an event that carries generated content, which is what TTFT measures. */
    isContentDelta(chunk: Chunk): boolean
  }
  export interface StartedStream<Chunk> {
    chunks: AsyncIterable<Chunk>
    iterator: AsyncIterator<Chunk>
  }
  export function startStream<Chunk>(source: AsyncIterable<Chunk>): Promise<StartedStream<Chunk>>
  export function sseResponse<Chunk>(
    started: StartedStream<Chunk>,
    protocol: StreamProtocol<Chunk>,
    identity: IdentityOptions,
    headers: HeadersInit,
    onSettle?: (outcome: StreamOutcome, capture: StreamCapture) => void,
    capture?: CaptureOptions,
  ): Response
  // StreamCapture gains one field:
  //   /** Epoch ms of the first content-bearing event, for TTFT. Null if none arrived. */
  //   firstDeltaAt: number | null
  // protocols/chat.ts
  export const chatStreamProtocol: StreamProtocol<ChatCompletionChunk>
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/gateway/sse.test.ts`:

```ts
import { chatStreamProtocol } from '@/lib/gateway/protocols/chat'

test('records the timestamp of the first content-bearing chunk, not the first chunk', async () => {
  const before = Date.now()
  const started = await startStream<ChatCompletionChunk>((async function* () {
    // The role delta carries no content: it must not count as time-to-first-token.
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } as ChatCompletionChunk
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as ChatCompletionChunk
  })())

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture })
  await res.text()

  expect(captured!.firstDeltaAt).toBeGreaterThanOrEqual(before)
})

test('leaves firstDeltaAt null when no content ever arrived', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] } as ChatCompletionChunk
  })())

  let captured: StreamCapture | null = null
  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'v' }, {},
    (_outcome, capture) => { captured = capture })
  await res.text()

  expect(captured!.firstDeltaAt).toBeNull()
})

test('still frames chat chunks as unnamed data events terminated by [DONE]', async () => {
  const started = await startStream<ChatCompletionChunk>((async function* () {
    yield { id: 'up', object: 'chat.completion.chunk', created: 1, model: 'up-m',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } as ChatCompletionChunk
  })())

  const res = sseResponse(started, chatStreamProtocol, { id: 'chatcmpl-1', model: 'virtual' }, {})
  const body = await res.text()

  expect(body).toContain('data: {')
  expect(body).not.toContain('event: ')
  expect(body).toContain('data: [DONE]')
  // The identity rewrite still applies.
  expect(body).toContain('"id":"chatcmpl-1"')
  expect(body).toContain('"model":"virtual"')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/gateway/sse.test.ts`
Expected: FAIL — `Cannot find module '@/lib/gateway/protocols/chat'`.

- [ ] **Step 3: Extract the protocol**

Create `src/lib/gateway/protocols/chat.ts`. Move `accumulate` out of `sse.ts` verbatim, keeping its comment about the post-truncation guard living at the call site:

```ts
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { LogUsage } from '@/lib/logs/types'
import type { ClassifiedError } from '../errors'
import { rewriteChunk } from '../identity'
import type { StreamCapture, StreamProtocol } from '../sse'
import { usageFrom } from '../usage'

const encoder = new TextEncoder()

/** Assembles assistant text for payload capture, stopping at the byte cap.
 *
 * The post-truncation guard (stop calling this once `captured.truncated` is
 * set) lives at the CALL SITE, not here — see the relay in sse.ts. Do not move
 * that check into this function: a future edit that relocates the call without
 * carrying the guard would let a later small chunk resume appending after
 * truncation. */
function accumulate(captured: StreamCapture, chunk: ChatCompletionChunk, maxBytes: number) {
  const delta = chunk.choices?.[0]?.delta?.content
  // Upstream JSON is untrusted: a non-string content field would make
  // Buffer.byteLength throw, and a throw here is inside the relay loop —
  // it would turn a healthy stream into an interrupted one.
  if (typeof delta !== 'string' || delta.length === 0) return
  const width = Buffer.byteLength(delta, 'utf8')
  // A running total rather than re-measuring the accumulated text on every
  // chunk, which would be quadratic over a token-per-chunk stream.
  if (captured.bytes + width > maxBytes) {
    captured.truncated = true
    return
  }
  captured.text += delta
  captured.bytes += width
}

export const chatStreamProtocol: StreamProtocol<ChatCompletionChunk> = {
  frame: (chunk, identity) =>
    encoder.encode(`data: ${JSON.stringify(rewriteChunk(chunk, identity))}\n\n`),
  terminator: encoder.encode('data: [DONE]\n\n'),
  errorEvent: (err: ClassifiedError) =>
    encoder.encode(`data: ${JSON.stringify({
      error: { message: err.message, type: err.type, param: null, code: 'stream_interrupted' },
    })}\n\n`),
  accumulate,
  usageOf: (chunk) => (chunk.usage ? usageFrom(chunk.usage) : null),
  // A chunk carrying reasoning but no content is still the first token from the
  // client's point of view: something generated arrived.
  isContentDelta: (chunk) => {
    const delta = chunk.choices?.[0]?.delta as { content?: unknown; reasoning_content?: unknown } | undefined
    return typeof delta?.content === 'string' && delta.content.length > 0
      || typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
  },
}
```

- [ ] **Step 4: Generalise `sse.ts`**

In `src/lib/gateway/sse.ts`: delete `event`, `DONE`, and `accumulate`; rename `StartedChatStream`→`StartedStream<Chunk>` and `startChatStream`→`startStream<Chunk>` (bodies unchanged, only the type parameter replaces `ChatCompletionChunk`). Add `firstDeltaAt: number | null` to `StreamCapture`, initialised `null`. Make `sseResponse` generic and take `protocol` as its second argument. Inside `start(controller)`, the loop body becomes:

```ts
for await (const chunk of started.chunks) {
  if (cancelled) return
  // include_usage puts this on the final chunk; a provider that omits
  // it simply leaves captured.usage null.
  const usage = protocol.usageOf(chunk)
  if (usage) captured.usage = usage
  // Recorded on the first content-bearing event rather than the first event
  // at all: a Responses stream opens with response.created, which upstream
  // emits instantly, and a chat stream opens with the role delta. Neither is
  // a token, and treating them as one reports a TTFT of nearly zero.
  if (captured.firstDeltaAt === null && protocol.isContentDelta(chunk)) {
    captured.firstDeltaAt = Date.now()
  }
  if (capture && !captured.truncated) protocol.accumulate(captured, chunk, capture.maxBytes)
  controller.enqueue(protocol.frame(chunk, identity))
}
```

The `catch` enqueues `protocol.errorEvent(classified)`; the `finally` enqueues `protocol.terminator` only when it is non-null. Everything else — `cancelled`, `settled`, `settle`, the `cancel()` cleanup and its comments — is untouched.

- [ ] **Step 5: Update the one call site**

In `chat-handler.ts`, `startChatStream(...)` becomes `startStream(...)`, and `sseResponse(result.value, identity, headers, …)` becomes `sseResponse(result.value, chatStreamProtocol, identity, headers, …)`. Replace the `ttftMs` computed after `execute` with one read from the capture inside the settle callback:

```ts
log(200, outcome, result.attempts, {
  ...(capture.firstDeltaAt === null ? {} : { ttftMs: capture.firstDeltaAt - startedAt }),
  candidate: result.candidate,
  // …unchanged…
})
```

Delete the now-unused `const ttftMs = Date.now() - startedAt` and its comment.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS. If a test asserted `ttftMs` was present on a stream that never produced content, update it — that is the intended behaviour change, and it is the only one.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/gateway/sse.ts src/lib/gateway/protocols/chat.ts src/lib/gateway/chat-handler.ts tests/lib/gateway/sse.test.ts
git commit -m "refactor(gateway): parameterise the SSE relay by protocol"
```

---

### Task 2: Extract the shared handler core

**Files:**
- Create: `src/lib/gateway/handler.ts`
- Modify: `src/lib/gateway/protocols/chat.ts` (add the `Ingress`)
- Modify: `src/lib/gateway/chat-handler.ts` (becomes a thin re-export)
- Test: `tests/gateway/*.test.ts` (existing — must pass unchanged)

**Interfaces:**
- Consumes: `chatStreamProtocol`, `StreamProtocol` (Task 1).
- Produces:
  ```ts
  // handler.ts
  export interface Ingress<Req, Res, Chunk> {
    parse(raw: unknown): Req
    modelOf(req: Req): string
    isStream(req: Req): boolean
    droppedFor(candidate: Candidate, req: Req): string[]
    run(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): Promise<Res>
    runStream(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): AsyncIterable<Chunk>
    finish(res: Res, identity: IdentityOptions): Res
    usageOf(res: Res): LogUsage | null
    newIdentityId(): string
    stream: StreamProtocol<Chunk>
    /** What payload capture stores for an interrupted or completed stream. */
    captureResponse(identity: IdentityOptions, capture: StreamCapture, outcome: StreamOutcome): unknown
  }
  export interface GatewayDeps { createAdapter: (provider: ProviderRow) => ProviderAdapter }
  export async function runGatewayRequest<Req, Res, Chunk>(
    request: Request, ingress: Ingress<Req, Res, Chunk>, deps?: GatewayDeps,
  ): Promise<Response>
  export function attemptHeaders(
    candidate: Candidate, requestId: string, dropped?: string[], limits?: LimitSnapshot | null,
  ): HeadersInit
  // protocols/chat.ts
  export const chatIngress: Ingress<ChatCompletionRequest, ChatCompletion, ChatCompletionChunk>
  ```

- [ ] **Step 1: Move the lifecycle**

Create `src/lib/gateway/handler.ts` holding, moved verbatim from `chat-handler.ts`: `attemptHeaders`, `ERROR_MESSAGE_MAX_LENGTH`, `buildPayload`, `errorMessage`, `isClassifiedError`, `errorFields`, and the whole body of `handleChatCompletions` renamed `runGatewayRequest`. Keep every explanatory comment — they document decisions, not code.

Replace the shape-specific expressions with descriptor calls:

| was | becomes |
|---|---|
| `parseBody(request)` (the zod block) | `ingress.parse(await readJson(request))` |
| `body.model` | `ingress.modelOf(body)` |
| `body.stream === true` | `ingress.isStream(body)` |
| `droppedFor(...)` | `ingress.droppedFor(...)` |
| `newCompletionId()` | `ingress.newIdentityId()` |
| `adapter.chat(bodyFor(candidate, body), ctx)` | `ingress.run(adapter, ctx, bodyFor(candidate, body))` |
| `startChatStream(adapter.chatStream(...))` | `startStream(ingress.runStream(adapter, ctx, bodyFor(candidate, body)))` |
| `rewriteCompletion(result.value, identity)` | `ingress.finish(result.value, identity)` |
| `usageFrom(result.value.usage)` | `ingress.usageOf(result.value)` |
| the inline fake `chat.completion` capture object | `ingress.captureResponse(identity, capture, outcome)` |
| `sseResponse(result.value, identity, …)` | `sseResponse(result.value, ingress.stream, identity, …)` |

`bodyFor` stays in `handler.ts` and stays shared — both shapes carry `service_tier` at the top level:

```ts
/**
 * The body to send to one particular target.
 *
 * A target with no tier gets the client's own object back, unchanged and
 * un-copied: "(none)" has to mean the request is not touched, which includes
 * not adding a `service_tier: null` the caller never sent. A configured tier
 * overwrites whatever the client asked for — it is an operator's routing
 * decision, not a default.
 *
 * Shared by both ingresses because both dialects spell it `service_tier` at
 * the top level, so there is nothing per-shape to decide.
 */
function bodyFor<Req>(candidate: Candidate, body: Req): Req {
  if (!candidate.serviceTier) return body
  return { ...body, service_tier: candidate.serviceTier }
}
```

Extract the JSON read so both ingresses report a malformed body identically:

```ts
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new GatewayError({
      status: 400, type: 'invalid_request_error', code: 'invalid_json',
      message: 'Request body could not be parsed as JSON.',
    })
  }
}
```

- [ ] **Step 2: Write the chat ingress**

Append to `src/lib/gateway/protocols/chat.ts`:

```ts
export const chatIngress: Ingress<ChatCompletionRequest, ChatCompletion, ChatCompletionChunk> = {
  parse: (raw) => parseWith(chatCompletionRequestSchema, raw),
  modelOf: (req) => req.model,
  isStream: (req) => req.stream === true,
  // Only Gemini translates today: the OpenAI-shaped adapters forward the
  // request as sent, so there is nothing they can fail to express.
  droppedFor: (candidate, req) =>
    candidate.provider.adapter === 'gemini' ? geminiDroppedParams(req) : [],
  run: (adapter, ctx, req) => adapter.chat(req, ctx),
  runStream: (adapter, ctx, req) => adapter.chatStream(req, ctx),
  finish: (res, identity) => rewriteCompletion(res, identity),
  usageOf: (res) => usageFrom(res.usage),
  newIdentityId: newCompletionId,
  stream: chatStreamProtocol,
  captureResponse: (identity, capture, outcome) => ({
    id: identity.id,
    object: 'chat.completion',
    model: identity.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: capture.text },
      finish_reason: outcome === 'ok' ? 'stop' : null,
    }],
  }),
}
```

`parseWith` is the shared zod-error-to-`GatewayError` mapping, moved from `parseBody` into `handler.ts` and exported:

```ts
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = (result.error as z.ZodError).issues[0]
    throw new GatewayError({
      status: 400, type: 'invalid_request_error', code: 'invalid_request',
      param: issue.path.length > 0 ? String(issue.path[0]) : null,
      message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
    })
  }
  return result.data
}
```

- [ ] **Step 3: Reduce `chat-handler.ts`**

```ts
import 'server-only'
import { chatIngress } from './protocols/chat'
import { runGatewayRequest, type GatewayDeps } from './handler'

export type ChatHandlerDeps = GatewayDeps

export function handleChatCompletions(
  request: Request,
  deps?: ChatHandlerDeps,
): Promise<Response> {
  return runGatewayRequest(request, chatIngress, deps)
}
```

Re-export `attemptHeaders` from here if any test imports it from this module; otherwise update those imports to `./handler`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, 992 tests. This task changes no behaviour — any failure is a porting mistake, not an expected update. Do not edit a test to make it pass.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/gateway/handler.ts src/lib/gateway/protocols/chat.ts src/lib/gateway/chat-handler.ts
git commit -m "refactor(gateway): extract a shared handler core from the chat ingress"
```

---

# Phase 2 — Flavor restored, and made per-target

At the end of this phase, chat-in to Responses-out works again as it did before `23dc469`, and the flavor is settable per route target.

### Task 3: Restore the chat-to-responses translator

**Files:**
- Restore: `src/lib/translate/chat-to-responses.ts`, `tests/lib/translate/chat-to-responses.test.ts`
- Modify: `src/lib/adapters/openai/paths.ts`
- Modify: `src/lib/adapters/types.ts` (the `responsesPath` config key)
- Test: `tests/lib/adapters/openai/paths.test.ts`

**Interfaces:**
- Produces: `toResponsesRequest(req, upstreamModel, config)`, `fromResponse(res)`, `fromResponseStream(events, req)`, `droppedParams(req)` from `@/lib/translate/chat-to-responses`; `DEFAULT_PATHS.responses = '/responses'` and `ProviderPaths.responses`.

- [ ] **Step 1: Restore the module and its tests**

```bash
git show 23dc469^:src/lib/translate/chat-to-responses.ts > src/lib/translate/chat-to-responses.ts
git show 23dc469^:tests/lib/translate/chat-to-responses.test.ts > tests/lib/translate/chat-to-responses.test.ts
```

- [ ] **Step 2: Restore the responses path**

Review what was removed, then re-apply only the `paths.ts` hunk:

```bash
git show 23dc469 -- src/lib/adapters/openai/paths.ts src/lib/adapters/types.ts
```

In `paths.ts` add `responses: '/responses'` to `DEFAULT_PATHS`, `responses: 'responsesPath'` to `CONFIG_KEYS`, the `responsesPath` entry to `PATH_FIELDS` (label "Responses path", help "Where this provider serves the Responses API."), and `responses: resolve('responses')` to the returned object. In `types.ts` add `responsesPath?: string` beside `chatCompletionsPath`.

- [ ] **Step 3: Restore the paths test expectations**

```bash
git show 23dc469 -- tests/lib/adapters/openai/paths.test.ts tests/lib/adapters/openai/custom-paths.test.ts tests/contract/custom-paths.test.ts
```

Re-apply the removed assertions — the ones expecting `responses` in the resolved paths and a `responsesPath` override to be honoured.

- [ ] **Step 4: Run the restored tests**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts tests/lib/adapters/openai/paths.test.ts`
Expected: PASS. `chat-to-responses.ts` is pure and has no dependency on anything else that was deleted; if it fails to import, something else in the restore is missing.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/chat-to-responses.ts tests/lib/translate/chat-to-responses.test.ts src/lib/adapters/openai/paths.ts src/lib/adapters/types.ts tests/lib/adapters/openai tests/contract/custom-paths.test.ts
git commit -m "feat(openai): restore the chat-to-responses translator and /responses path"
```

---

### Task 4: Restore the Responses adapter and the provider-level selector

**Files:**
- Restore: `src/lib/adapters/openai/responses.ts` and the deleted adapter tests
- Modify: `src/lib/adapters/registry.ts`, `src/lib/adapters/openai/errors.ts`, `src/lib/db/schema.ts`
- Create: `src/lib/api-flavors.ts`
- Modify: `src/app/(admin)/providers/{provider-form,edit-provider-form,actions,page}.tsx|ts`, `src/lib/admin/providers.ts`
- Test: `tests/lib/adapters/registry.test.ts`, `tests/lib/admin/providers.test.ts`, `tests/lib/db/schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/lib/api-flavors.ts
  export const API_FLAVORS = ['chat_completions', 'responses'] as const
  export type ApiFlavor = (typeof API_FLAVORS)[number]
  // registry.ts
  export function createAdapter(provider: ProviderRow, flavor?: ApiFlavor): ProviderAdapter
  ```

- [ ] **Step 1: Create the flavor module**

```ts
/**
 * Which protocol a provider's endpoint speaks.
 *
 * Its own module rather than a constant in the schema or the admin layer,
 * because the provider and target dialogs are client components: they need
 * this list to render the selector, and both of those modules are server-only.
 * The schema's pgEnum is built from this array, so the column and the selector
 * cannot drift.
 */
export const API_FLAVORS = ['chat_completions', 'responses'] as const

export type ApiFlavor = (typeof API_FLAVORS)[number]
```

Point `apiFlavorEnum` in `src/lib/db/schema.ts:25` at it: `pgEnum('api_flavor', API_FLAVORS)`. The enum values are unchanged, so `pnpm db:generate` must produce **no** migration — verify that in Step 5.

- [ ] **Step 2: Restore the adapter and wire the registry**

```bash
git show 23dc469^:src/lib/adapters/openai/responses.ts > src/lib/adapters/openai/responses.ts
git show 23dc469^:tests/lib/adapters/openai/responses-chat.test.ts > tests/lib/adapters/openai/responses-chat.test.ts
git show 23dc469^:tests/lib/adapters/openai/responses-stream.test.ts > tests/lib/adapters/openai/responses-stream.test.ts
git show 23dc469^:tests/lib/adapters/openai/responses-models.test.ts > tests/lib/adapters/openai/responses-models.test.ts
```

Then in `registry.ts`:

```ts
export function createAdapter(
  provider: ProviderRow,
  flavor: ApiFlavor = provider.apiFlavor,
): ProviderAdapter {
  const runtime = resolveProviderRuntime(provider)

  switch (runtime.adapter) {
    case 'openai':
      return openAIShaped(runtime, flavor)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return openAIShaped(runtime, flavor)
    case 'gemini':
      // Gemini speaks neither OpenAI dialect natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way.
      return createGeminiAdapter(runtime)
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}

function openAIShaped(runtime: ProviderRuntime, flavor: ApiFlavor): ProviderAdapter {
  return flavor === 'responses'
    ? createResponsesAdapter(runtime)
    : createOpenAIAdapter(runtime)
}
```

Restore the `FLAVOR_HINT` on the chat side too:

```bash
git show 23dc469 -- src/lib/adapters/openai/errors.ts src/lib/adapters/openai/index.ts
```

- [ ] **Step 3: Restore the provider admin UI**

```bash
git show 23dc469 -- 'src/app/(admin)/providers' src/lib/admin/providers.ts
```

Re-apply each removed hunk: the `apiFlavor` select in `provider-form.tsx` and `edit-provider-form.tsx` (rendered only for `openai` / `openai_compatible`), the `apiFlavor` field in `actions.ts`, the badge on `page.tsx`, and the `apiFlavor` handling in `src/lib/admin/providers.ts`. Import `API_FLAVORS` from `@/lib/api-flavors` to build the options rather than hardcoding two `<option>` elements.

- [ ] **Step 4: Restore the tests**

```bash
git show 23dc469 -- tests/lib/adapters/registry.test.ts tests/lib/admin/providers.test.ts tests/lib/db/schema.test.ts
```

Re-apply the removed assertions. In `registry.test.ts`, add one for the new argument:

```ts
test('an explicit flavor overrides the provider column', () => {
  const provider = providerRow({ apiFlavor: 'chat_completions' })
  // The per-target override arrives as an argument, so a target may reach the
  // Responses endpoint of a provider whose default is Chat Completions.
  expect(createAdapter(provider, 'responses')).toHaveProperty('chat')
  expect(() => createAdapter(provider, 'responses')).not.toThrow()
})
```

- [ ] **Step 5: Verify no migration was generated**

Run: `pnpm db:generate`
Expected: "No schema changes, nothing to migrate." If a migration file appears, the enum values drifted — delete it and fix `API_FLAVORS` to match `drizzle/0002_strange_carlie_cooper.sql` exactly.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add -A
git commit -m "feat(openai): restore the Responses adapter and the provider flavor selector"
```

---

### Task 5: Resolve the flavor per route target

**Files:**
- Modify: `src/lib/db/schema.ts:67-88`, `src/lib/gateway/resolve.ts:108-118,161-175`, `src/lib/gateway/execute.ts:31-45,142`, `src/lib/admin/models.ts`
- Create: `drizzle/0008_*.sql` (generated), `src/app/(admin)/models/api-flavor-select.tsx`
- Modify: `src/app/(admin)/models/{edit-target-form,add-target-form,actions,target-row-actions}.tsx|ts`, `src/app/(admin)/models/[id]/page.tsx`
- Modify: `tests/helpers/gateway.ts`
- Test: `tests/lib/gateway/resolve.test.ts`, `tests/lib/admin/models.test.ts`

**Interfaces:**
- Consumes: `ApiFlavor` (Task 4).
- Produces: `Candidate.apiFlavor: ApiFlavor`; `routeTargets.apiFlavor` column; `RouteTargetInput.apiFlavor?: ApiFlavor | null`; `TargetSpec.apiFlavor?: ApiFlavor | null` and `SeedOptions.apiFlavor?: ApiFlavor | null` in the test helpers; `ExecuteDeps.createAdapter: (provider: ProviderRow, flavor: ApiFlavor) => ProviderAdapter`.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/gateway/resolve.test.ts`:

```ts
test('a target with no flavor inherits the provider', async () => {
  const { model } = await seedTargets({
    targets: [{ name: 'p1' }],
  })
  await db.update(providers).set({ apiFlavor: 'responses' })

  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a target flavor overrides the provider', async () => {
  const { model } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }],
  })
  // The provider still says chat_completions; the target wins.
  const { candidates } = await resolveModel(model.name)

  expect(candidates[0].apiFlavor).toBe('responses')
})

test('a direct provider/model address inherits the provider flavor', async () => {
  // No route_targets row stands behind a direct address, so there is nothing
  // that could have overridden the provider's setting.
  const provider = await seedCatalogModel({ provider: 'openai', model: 'gpt-5', apiFlavor: 'responses' })

  const { candidates } = await resolveModel(`${provider.name}/gpt-5`)

  expect(candidates[0].apiFlavor).toBe('responses')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/gateway/resolve.test.ts`
Expected: FAIL — `apiFlavor` is not a property of `Candidate`, and `seedTargets` rejects the option.

- [ ] **Step 3: Add the column and generate the migration**

In `src/lib/db/schema.ts`, inside `routeTargets`, directly after `serviceTier`:

```ts
  // Nullable with no default, because NULL is a distinct behaviour rather than
  // a missing value: it means "inherit the provider's flavor". A default would
  // make a target that was deliberately set to chat_completions
  // indistinguishable from one that was never configured.
  apiFlavor: apiFlavorEnum('api_flavor'),
```

Run: `pnpm db:generate`
Expected: one new file adding a nullable `api_flavor` column to `route_targets` and nothing else. Read it and confirm it contains no `DROP` and no `NOT NULL`.

- [ ] **Step 4: Resolve it into `Candidate`**

In `resolve.ts`, add to the `Candidate` interface:

```ts
  /** The protocol this target's endpoint speaks. Resolved rather than
   *  nullable: NULL on the target means "inherit the provider", and the
   *  routing loop must never have to know that. */
  apiFlavor: ApiFlavor
```

In `findVirtualModel`'s `rows.map`, add `apiFlavor: target.apiFlavor ?? provider.apiFlavor,`. In `resolveDirect`'s single candidate, add `apiFlavor: row.provider.apiFlavor,` with the comment that no `route_targets` row stands behind a direct address.

- [ ] **Step 5: Pass it through `execute`**

In `execute.ts`, widen `ExecuteDeps.createAdapter` to `(provider: ProviderRow, flavor: ApiFlavor) => ProviderAdapter` and change line 142 to `deps.createAdapter(candidate.provider, candidate.apiFlavor)`. `handler.ts`'s `GatewayDeps` takes the same signature; `catalog/sync.ts` and `admin/providers.ts` keep calling `createAdapter(provider)` with one argument, which resolves to the provider's own flavor — correct for both, since they hit `/v1/models`, the same endpoint under either flavor.

Update `tests/helpers/gateway.ts`: add `apiFlavor?: ApiFlavor | null` to `SeedOptions` and `TargetSpec`, insert it into both `routeTargets` inserts, and widen `fakeAdapterDeps`/`fakeAdapterByProvider` to accept the second argument (they can ignore it).

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/lib/gateway/resolve.test.ts`
Expected: PASS.

- [ ] **Step 7: Thread it through the admin layer**

In `src/lib/admin/models.ts`: add `apiFlavor?: ApiFlavor | null` to `RouteTargetInput` and to the update patch type; validate it the way `serviceTier` is validated at line 238 (`if (input.apiFlavor !== undefined) { if (input.apiFlavor !== null && !API_FLAVORS.includes(input.apiFlavor)) throw … }`); include it in the insert, the update patch, and the `VirtualModelListItem` target projection.

Create `src/app/(admin)/models/api-flavor-select.tsx`, mirroring `service-tier-select.tsx` — a bare `<select>`, not the shadcn Select, because these dialogs submit real FormData:

```tsx
'use client'

import { API_FLAVORS, type ApiFlavor } from '@/lib/api-flavors'

const LABELS: Record<ApiFlavor, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
}

/**
 * The flavor selector both target dialogs render.
 *
 * "(inherit)" submits an empty string, which the action turns back into NULL —
 * the value that makes the target follow its provider's setting.
 */
export function ApiFlavorSelect({
  id,
  defaultValue,
  providerDefault,
}: {
  id: string
  defaultValue?: ApiFlavor | null
  /** Shown in the inherit option so an operator can see what blank means
   *  without opening the Providers page. */
  providerDefault: ApiFlavor
}) {
  return (
    <select
      id={id}
      name="apiFlavor"
      defaultValue={defaultValue ?? ''}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">(inherit — {LABELS[providerDefault]})</option>
      {API_FLAVORS.map((flavor) => (
        <option key={flavor} value={flavor}>{LABELS[flavor]}</option>
      ))}
    </select>
  )
}
```

In `actions.ts`, add the mirror of `serviceTierValue`:

```ts
/**
 * The flavor select submits an empty string for "(inherit)", which has to reach
 * the column as NULL — that is what makes the target follow its provider.
 * Anything non-empty goes through unvalidated on purpose: the admin layer owns
 * the enum check, so there is one place that can reject an unknown flavor.
 */
function apiFlavorValue(value: FormDataEntryValue | null): ApiFlavor | null {
  const flavor = String(value ?? '')
  return flavor === '' ? null : (flavor as ApiFlavor)
}
```

and pass `apiFlavor: apiFlavorValue(formData.get('apiFlavor'))` in both `addTargetAction` and `updateTargetAction`.

Render `<ApiFlavorSelect>` in `edit-target-form.tsx` and the add-target dialog, beside the service-tier field, with help text: *"Which endpoint this target is called on. Only meaningful for OpenAI-shaped providers."* In `models/[id]/page.tsx`, show a `<Badge variant="outline">` with the flavor **only when `target.apiFlavor` is non-null**, matching how the service-tier badge is conditioned.

Finally, update `FLAVOR_HINT` in `src/lib/adapters/openai/responses.ts` and its mirror in `src/lib/adapters/openai/errors.ts` to point at the target rather than only the provider, since that is now where the setting can live:

> `If this endpoint only implements the Chat Completions API, set the route target's API flavor to "chat_completions" — or the provider's, if every target should follow it.`

- [ ] **Step 8: Write the admin test**

Append to `tests/lib/admin/models.test.ts`:

```ts
test('rejects an unknown api flavor', async () => {
  const { model, provider } = await seedModelAndProvider()

  await expect(addRouteTarget({
    virtualModelId: model.id, providerId: provider.id,
    upstreamModel: 'gpt-5', apiFlavor: 'grpc' as ApiFlavor,
  })).rejects.toThrow('"grpc" is not a supported API flavor.')
})

test('stores a null flavor as inherit', async () => {
  const { model, provider } = await seedModelAndProvider()

  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-5',
  })

  expect(target.apiFlavor).toBeNull()
})
```

- [ ] **Step 9: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add -A
git commit -m "feat(models): resolve the API flavor per route target"
```

---

# Phase 3 — `/v1/responses`, passthrough only

Responses-in to Responses-out, lossless end to end. A Responses request routed to a chat-only target fails with the existing 501 `unsupported_operation` until Phase 4.

### Task 6: The Responses request schema

**Files:**
- Create: `src/lib/schemas/responses.ts`
- Test: `tests/lib/schemas/responses.test.ts`

**Interfaces:**
- Produces: `responsesRequestSchema`, `type ResponsesRequest` from `@/lib/schemas/responses`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { responsesRequestSchema } from '@/lib/schemas/responses'

test('accepts a bare string input', () => {
  const parsed = responsesRequestSchema.parse({ model: 'm', input: 'hello' })
  expect(parsed.input).toBe('hello')
})

test('accepts structured input items', () => {
  const parsed = responsesRequestSchema.parse({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  })
  expect(Array.isArray(parsed.input)).toBe(true)
})

test('keeps unknown keys so they reach the provider', () => {
  // Passthrough is the whole point of the Responses-native path: a field this
  // gateway has never heard of must not be stripped on its way upstream.
  const parsed = responsesRequestSchema.parse({ model: 'm', input: 'hi', some_new_field: 1 })
  expect((parsed as Record<string, unknown>).some_new_field).toBe(1)
})

test('rejects background because the retrieval endpoints do not exist', () => {
  // Rejected for every target, not just chat-only ones: a queued response would
  // be unretrievable, since GET /v1/responses/{id} is out of scope.
  const result = responsesRequestSchema.safeParse({ model: 'm', input: 'hi', background: true })
  expect(result.success).toBe(false)
})

test('allows background: false', () => {
  expect(responsesRequestSchema.safeParse({ model: 'm', input: 'hi', background: false }).success).toBe(true)
})

test('requires a model', () => {
  expect(responsesRequestSchema.safeParse({ input: 'hi' }).success).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/schemas/responses.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

```ts
import { z } from 'zod'

const inputContent = z.union([
  z.looseObject({ type: z.literal('input_text'), text: z.string() }),
  z.looseObject({ type: z.literal('input_image'), image_url: z.string().optional() }),
  z.looseObject({ type: z.literal('output_text'), text: z.string() }),
  z.looseObject({ type: z.string() }),
])

const inputItem = z.union([
  z.looseObject({
    type: z.literal('message'),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(inputContent)]),
  }),
  z.looseObject({
    type: z.literal('function_call'),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.looseObject({
    type: z.literal('function_call_output'),
    call_id: z.string(),
    output: z.string(),
  }),
  z.looseObject({ type: z.literal('reasoning') }),
  z.looseObject({ type: z.literal('item_reference'), id: z.string() }),
  // A shape this gateway has not been taught. Kept rather than rejected: on the
  // passthrough path the provider may well understand it, and the translator
  // reports it as dropped rather than refusing the request.
  z.looseObject({ type: z.string() }),
])

const tool = z.looseObject({ type: z.string() })

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({ type: z.string() }),
])

export const responsesRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(inputItem)]),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  max_tool_calls: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  text: z.looseObject({ format: z.looseObject({ type: z.string() }).optional() }).optional(),
  // Typed as a free string for the same reason as the chat schema's
  // reasoning_effort: new effort tiers appear faster than this would be updated.
  reasoning: z.looseObject({
    effort: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
  }).optional(),
  truncation: z.string().nullable().optional(),
  include: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  store: z.boolean().nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  conversation: z.union([z.string(), z.looseObject({ id: z.string() })]).nullable().optional(),
  prompt_cache_key: z.string().optional(),
  safety_identifier: z.string().optional(),
  // Rejected rather than dropped: a queued response would be unretrievable,
  // because GET /v1/responses/{id} is deliberately out of scope. Refusing at
  // parse time keeps it out of every path, not just the translated one.
  background: z.literal(false).nullable().optional(),
  service_tier: z.string().nullable().optional(),
  user: z.string().optional(),
})

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/schemas/responses.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/schemas/responses.ts tests/lib/schemas/responses.test.ts
git commit -m "feat(schemas): add the Responses API request schema"
```

---

### Task 7: `respond` and `respondStream` on the Responses adapter

**Files:**
- Modify: `src/lib/adapters/types.ts`, `src/lib/adapters/openai/responses.ts`
- Test: `tests/lib/adapters/openai/responses-respond.test.ts`

**Interfaces:**
- Consumes: `ResponsesRequest` (Task 6), `resolveProviderPaths(...).responses` (Task 3).
- Produces:
  ```ts
  // types.ts
  export type ResponsesResult = OpenAI.Responses.Response
  export type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent
  export interface ProviderAdapter {
    // …existing…
    /** Optional until Phase 4: an adapter without it answers a Responses
     *  request with 501 unsupported_operation rather than a missing method. */
    respond?(req: ResponsesRequest, ctx: AttemptContext): Promise<ResponsesResult>
    respondStream?(req: ResponsesRequest, ctx: AttemptContext): AsyncIterable<ResponseStreamEvent>
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test, vi } from 'vitest'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'

function runtime() {
  return {
    id: 'p1', name: 'p', adapter: 'openai' as const, baseUrl: null,
    credentials: { apiKey: 'sk-x' }, config: {},
  }
}

const ctx = { upstreamModel: 'gpt-5', signal: new AbortController().signal, requestId: 'r1' }

test('respond forwards the request untouched except for the model', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'resp_up', object: 'response', output: [] })
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  await adapter.respond!(
    { model: 'virtual', input: 'hi', tools: [{ type: 'web_search' }] },
    ctx,
  )

  // Passthrough means passthrough: the hosted tool survives, and only the
  // model is swapped for the target's upstream name.
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gpt-5', input: 'hi', tools: [{ type: 'web_search' }], stream: false }),
    expect.objectContaining({ path: '/responses' }),
  )
})

test('respond wraps an SDK failure as a ProviderError', async () => {
  const create = vi.fn().mockRejectedValue(new OpenAI.APIError(429, { message: 'slow down' }, 'slow down', undefined))
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  await expect(adapter.respond!({ model: 'm', input: 'hi' }, ctx)).rejects.toMatchObject({
    name: 'ProviderError', status: 429, retryable: true,
  })
})

test('respondStream yields upstream events unchanged', async () => {
  const create = vi.fn().mockResolvedValue((async function* () {
    yield { type: 'response.created', sequence_number: 0 }
    yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
  })())
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  const events = []
  for await (const event of adapter.respondStream!({ model: 'm', input: 'hi', stream: true }, ctx)) {
    events.push(event)
  }

  expect(events.map((e) => e.type)).toEqual(['response.created', 'response.output_text.delta'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/adapters/openai/responses-respond.test.ts`
Expected: FAIL — `adapter.respond` is undefined.

- [ ] **Step 3: Implement the passthrough pair**

Add the optional pair to `ProviderAdapter` in `types.ts` with the doc comment above, then add to `createResponsesAdapter`'s returned object:

```ts
    /**
     * The matching path: Responses in, Responses out. No translation at all —
     * which is the whole reason this pair exists rather than the ingress
     * normalising to Chat Completions. Hosted tools, reasoning items and
     * encrypted content survive only here.
     */
    async respond(req, ctx): Promise<ResponsesResult> {
      try {
        return await client.responses.create(
          { ...req, model: ctx.upstreamModel, stream: false },
          { signal: ctx.signal, path: paths.responses },
        ) as ResponsesResult
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    async *respondStream(req, ctx): AsyncIterable<ResponseStreamEvent> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream
      try {
        stream = await client.responses.create(
          { ...req, model: ctx.upstreamModel, stream: true },
          { signal: ctx.signal, path: paths.responses },
        )
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        for await (const event of stream as AsyncIterable<ResponseStreamEvent>) yield event
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/adapters/openai/responses-respond.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/adapters/types.ts src/lib/adapters/openai/responses.ts tests/lib/adapters/openai/responses-respond.test.ts
git commit -m "feat(openai): serve /v1/responses natively via respond and respondStream"
```

---

### Task 8: The Responses stream protocol and usage normalizer

**Files:**
- Create: `src/lib/gateway/protocols/responses.ts`
- Modify: `src/lib/gateway/usage.ts`, `src/lib/gateway/identity.ts`
- Test: `tests/lib/gateway/responses-protocol.test.ts`, `tests/lib/gateway/usage.test.ts`

**Interfaces:**
- Consumes: `StreamProtocol` (Task 1), `ResponseStreamEvent` (Task 7).
- Produces:
  ```ts
  export const responsesStreamProtocol: StreamProtocol<ResponseStreamEvent>
  export function newResponseId(): string                       // identity.ts
  export function rewriteResponse<T>(res: T, identity: IdentityOptions): T  // identity.ts
  export function usageFromResponses(raw): LogUsage | null      // usage.ts
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { responsesStreamProtocol as p } from '@/lib/gateway/protocols/responses'
import { usageFromResponses } from '@/lib/gateway/usage'

const identity = { id: 'resp_gw', model: 'virtual' }
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('frames an event with a named event line', () => {
  const framed = decode(p.frame({ type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' } as never, identity))

  expect(framed).toBe('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"hi"}\n\n')
})

test('does not terminate the stream with [DONE]', () => {
  // The real API ends on response.completed; the installed SDK treats [DONE]
  // as optional (openai/core/streaming.js:35).
  expect(p.terminator).toBeNull()
})

test('rewrites the model on events carrying a response, and never the id', () => {
  const framed = decode(p.frame({
    type: 'response.created', sequence_number: 0,
    response: { id: 'resp_upstream', model: 'gpt-5-2026', output: [] },
  } as never, identity))

  // The id is what the client sends back as previous_response_id, so it must
  // stay the provider's own.
  expect(framed).toContain('"id":"resp_upstream"')
  expect(framed).toContain('"model":"virtual"')
})

test('reads usage off the terminal event', () => {
  const usage = p.usageOf({
    type: 'response.completed', sequence_number: 9,
    response: { usage: {
      input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: { cached_tokens: 6 },
      output_tokens_details: { reasoning_tokens: 2 },
    } },
  } as never)

  expect(usage).toEqual({ promptTokens: 10, completionTokens: 4, cachedTokens: 6, reasoningTokens: 2 })
})

test('reports no usage on a non-terminal event', () => {
  expect(p.usageOf({ type: 'response.output_text.delta', sequence_number: 1, delta: 'x' } as never)).toBeNull()
})

test('counts only text and reasoning deltas as content', () => {
  expect(p.isContentDelta({ type: 'response.created', sequence_number: 0 } as never)).toBe(false)
  expect(p.isContentDelta({ type: 'response.in_progress', sequence_number: 1 } as never)).toBe(false)
  expect(p.isContentDelta({ type: 'response.output_text.delta', sequence_number: 2, delta: 'x' } as never)).toBe(true)
  expect(p.isContentDelta({ type: 'response.reasoning_summary_text.delta', sequence_number: 2, delta: 'x' } as never)).toBe(true)
})

test('frames a mid-stream failure as a named error event', () => {
  const framed = decode(p.errorEvent({
    retryable: true, status: 502, type: 'api_error', code: 'upstream_error', message: 'boom',
  }))

  expect(framed).toContain('event: error\n')
  expect(framed).toContain('"type":"error"')
  expect(framed).toContain('"message":"boom"')
})

test('accumulates only output text for payload capture', () => {
  const captured = { usage: null, text: '', bytes: 0, truncated: false, error: null, firstDeltaAt: null }
  p.accumulate(captured, { type: 'response.output_text.delta', sequence_number: 1, delta: 'ab' } as never, 100)
  p.accumulate(captured, { type: 'response.reasoning_summary_text.delta', sequence_number: 2, delta: 'zz' } as never, 100)

  // Reasoning is not the assistant's answer, so it stays out of the captured text.
  expect(captured.text).toBe('ab')
})

test('stops accumulating at the byte cap', () => {
  const captured = { usage: null, text: '', bytes: 0, truncated: false, error: null, firstDeltaAt: null }
  p.accumulate(captured, { type: 'response.output_text.delta', sequence_number: 1, delta: 'abcdef' } as never, 3)

  expect(captured.truncated).toBe(true)
  expect(captured.text).toBe('')
})
```

And in `tests/lib/gateway/usage.test.ts`:

```ts
test('normalizes Responses usage onto the same LogUsage shape', () => {
  expect(usageFromResponses({
    input_tokens: 7, output_tokens: 3,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  })).toEqual({ promptTokens: 7, completionTokens: 3, cachedTokens: 2, reasoningTokens: 1 })
})

test('leaves unmeasured Responses counts null rather than zero', () => {
  expect(usageFromResponses({ input_tokens: 7, output_tokens: 3 }))
    .toEqual({ promptTokens: 7, completionTokens: 3, cachedTokens: null, reasoningTokens: null })
})

test('returns null when the provider reported no usage at all', () => {
  expect(usageFromResponses(null)).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/gateway/responses-protocol.test.ts tests/lib/gateway/usage.test.ts`
Expected: FAIL — module and function not found.

- [ ] **Step 3: Add the usage normalizer**

In `usage.ts`, beside `usageFrom`:

```ts
interface RawResponsesUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  input_tokens_details?: { cached_tokens?: number | null } | null
  output_tokens_details?: { reasoning_tokens?: number | null } | null
}

/**
 * The Responses spelling of the same four numbers. A second normalizer rather
 * than a union inside usageFrom, because the two shapes share no field name and
 * a merged function would have to guess which dialect it was handed.
 */
export function usageFromResponses(raw: RawResponsesUsage | null | undefined): LogUsage | null {
  if (!raw) return null
  return {
    promptTokens: count(raw.input_tokens),
    completionTokens: count(raw.output_tokens),
    cachedTokens: count(raw.input_tokens_details?.cached_tokens),
    reasoningTokens: count(raw.output_tokens_details?.reasoning_tokens),
  }
}
```

- [ ] **Step 4: Add the identity helpers**

In `identity.ts`:

```ts
export function newResponseId(): string {
  return `resp_${randomUUID().replaceAll('-', '')}`
}

/**
 * Rewrites the model, and deliberately NOT the id.
 *
 * /v1/chat/completions replaces the upstream id with a gateway-minted one, but
 * a Responses id is what the client sends back as `previous_response_id`: an id
 * the provider has never seen would break the follow-up. The provider owns the
 * conversation, so the provider owns the id.
 */
export function rewriteResponse<T extends { model?: string }>(
  res: T,
  { model }: IdentityOptions,
): T {
  return { ...res, model }
}
```

- [ ] **Step 5: Write the protocol**

```ts
import type { ResponseStreamEvent } from '@/lib/adapters/types'
import type { LogUsage } from '@/lib/logs/types'
import type { ClassifiedError } from '../errors'
import { rewriteResponse } from '../identity'
import type { StreamCapture, StreamProtocol } from '../sse'
import { usageFromResponses } from '../usage'

const encoder = new TextEncoder()

const CONTENT_DELTAS = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
])

/** The events that carry a full response object, whose model needs rewriting
 *  to the virtual name the client asked for. */
const CARRIES_RESPONSE = new Set([
  'response.created', 'response.in_progress', 'response.completed',
  'response.incomplete', 'response.failed', 'response.queued',
])

export const responsesStreamProtocol: StreamProtocol<ResponseStreamEvent> = {
  frame: (event, identity) => {
    const payload = CARRIES_RESPONSE.has(event.type) && 'response' in event
      ? { ...event, response: rewriteResponse(event.response, identity) }
      : event
    // Both lines: the real API sends a named event, and clients that are not
    // the OpenAI SDK read `event:` rather than sniffing `data.type`.
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)
  },

  // The real API ends on response.completed and sends no sentinel; the SDK
  // treats [DONE] as optional (openai/core/streaming.js:35).
  terminator: null,

  errorEvent: (err: ClassifiedError) =>
    encoder.encode(`event: error\ndata: ${JSON.stringify({
      type: 'error', code: 'stream_interrupted', message: err.message, param: null,
    })}\n\n`),

  accumulate: (captured: StreamCapture, event, maxBytes) => {
    // Only the assistant's answer. Reasoning summaries are not what the client
    // received as content, so capturing them would misrepresent the response.
    if (event.type !== 'response.output_text.delta') return
    const delta = (event as { delta?: unknown }).delta
    // Upstream JSON is untrusted: a non-string delta would make
    // Buffer.byteLength throw, and a throw here is inside the relay loop —
    // it would turn a healthy stream into an interrupted one.
    if (typeof delta !== 'string' || delta.length === 0) return
    const width = Buffer.byteLength(delta, 'utf8')
    if (captured.bytes + width > maxBytes) {
      captured.truncated = true
      return
    }
    captured.text += delta
    captured.bytes += width
  },

  usageOf: (event): LogUsage | null => {
    if (!('response' in event) || !event.response) return null
    return usageFromResponses((event.response as { usage?: unknown }).usage as never)
  },

  isContentDelta: (event) => CONTENT_DELTAS.has(event.type),
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/lib/gateway/responses-protocol.test.ts tests/lib/gateway/usage.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/gateway/protocols/responses.ts src/lib/gateway/usage.ts src/lib/gateway/identity.ts tests/lib/gateway
git commit -m "feat(gateway): add the Responses stream protocol and usage normalizer"
```

---

### Task 9: The `/v1/responses` route

**Files:**
- Create: `src/app/v1/responses/route.ts`, `src/lib/gateway/responses-handler.ts`
- Modify: `src/lib/gateway/protocols/responses.ts` (add the `Ingress`)
- Modify: `tests/helpers/gateway.ts` (add `responsesRequest`)
- Test: `tests/gateway/responses-ingress.test.ts`, `tests/contract/openai-client.test.ts`

**Interfaces:**
- Consumes: `runGatewayRequest`/`Ingress` (Task 2), `responsesRequestSchema` (Task 6), `respond`/`respondStream` (Task 7), `responsesStreamProtocol` (Task 8).
- Produces: `export const responsesIngress`; `handleResponses(request, deps?)`; `responsesRequest(body, apiKey)` test helper.

- [ ] **Step 1: Write the failing test**

`tests/gateway/responses-ingress.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { responsesRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

function response(id: string) {
  return {
    id, object: 'response', created_at: 1, model: 'up-model', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('serves a Responses request from a Responses-native target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({ p1: { respond: vi.fn().mockResolvedValue(response('resp_upstream')) } }),
  )

  expect(res.status).toBe(200)
  const body = await res.json()
  // The provider's id survives, because the client sends it back as
  // previous_response_id; the model becomes the virtual name.
  expect(body.id).toBe('resp_upstream')
  expect(body.model).toBe('house-model')
  expect(res.headers.get('x-babellm-provider')).toBe('p1')
})

test('rejects a request with no credentials', async () => {
  await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(responsesRequest({ model: 'house-model', input: 'hi' }, null), {})

  expect(res.status).toBe(401)
})

test('rejects background at parse time, before any target is tried', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const respond = vi.fn()

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', background: true }, apiKey),
    fakeAdapterByProvider({ p1: { respond } }),
  )

  expect(res.status).toBe(400)
  expect(respond).not.toHaveBeenCalled()
})

test('fails over to a second Responses target', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }, { name: 'p2', apiFlavor: 'responses' }],
  })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({
      p1: { respond: vi.fn().mockRejectedValue(new OpenAI.APIError(429, { message: 'slow' }, 'slow', undefined)) },
      p2: { respond: vi.fn().mockResolvedValue(response('resp_two')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('p2')
})

test('answers 501 when the target cannot serve the Responses shape', async () => {
  // Until Phase 4 a chat-only target has no respond method at all.
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({ p1: {} }),
  )

  expect(res.status).toBe(501)
})

test('streams named events and never sends [DONE]', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', stream: true }, apiKey),
    fakeAdapterByProvider({ p1: { async *respondStream() {
      yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', model: 'up', output: [] } }
      yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
      yield { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', model: 'up', output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    } } }),
  )

  const body = await res.text()
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(body).toContain('event: response.created')
  expect(body).toContain('event: response.output_text.delta')
  expect(body).toContain('event: response.completed')
  expect(body).not.toContain('[DONE]')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/gateway/responses-ingress.test.ts`
Expected: FAIL — `@/lib/gateway/responses-handler` not found.

- [ ] **Step 3: Add the test helper**

In `tests/helpers/gateway.ts`, beside `chatRequest`:

```ts
export function responsesRequest(body: unknown, apiKey: string | null) {
  return new Request('http://gateway.test/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 4: Write the ingress**

Append to `src/lib/gateway/protocols/responses.ts`:

```ts
/**
 * An adapter that does not implement the pair cannot serve this shape at all.
 * 501 rather than 500: classifyProviderError already maps
 * UnsupportedOperationError to a non-retryable 501, which is the same answer an
 * unimplemented adapter type gives.
 */
function requirePair<T>(method: T | undefined, ctx: AttemptContext, name: string): T {
  if (!method) {
    throw new UnsupportedOperationError(
      `This provider cannot serve a Responses request for \`${ctx.upstreamModel}\`: it has no ${name} implementation. Set the route target's API flavor to "responses".`,
    )
  }
  return method
}

export const responsesIngress: Ingress<ResponsesRequest, ResponsesResult, ResponseStreamEvent> = {
  parse: (raw) => parseWith(responsesRequestSchema, raw),
  modelOf: (req) => req.model,
  isStream: (req) => req.stream === true,
  // Filled in by Task 14; a passthrough target expresses everything it is sent.
  droppedFor: () => [],
  run: (adapter, ctx, req) =>
    requirePair(adapter.respond, ctx, 'respond').call(adapter, req, ctx),
  runStream: (adapter, ctx, req) =>
    requirePair(adapter.respondStream, ctx, 'respondStream').call(adapter, req, ctx),
  finish: (res, identity) => rewriteResponse(res, identity),
  usageOf: (res) => usageFromResponses(res.usage as never),
  newIdentityId: newResponseId,
  stream: responsesStreamProtocol,
  captureResponse: (identity, capture, outcome) => ({
    id: identity.id,
    object: 'response',
    model: identity.model,
    status: outcome === 'ok' ? 'completed' : 'incomplete',
    output: [{
      type: 'message', role: 'assistant', status: outcome === 'ok' ? 'completed' : 'incomplete',
      content: [{ type: 'output_text', text: capture.text, annotations: [] }],
    }],
  }),
}
```

Create `src/lib/gateway/responses-handler.ts`:

```ts
import 'server-only'
import { responsesIngress } from './protocols/responses'
import { runGatewayRequest, type GatewayDeps } from './handler'

export function handleResponses(request: Request, deps?: GatewayDeps): Promise<Response> {
  return runGatewayRequest(request, responsesIngress, deps)
}
```

Create `src/app/v1/responses/route.ts`:

```ts
import { handleResponses } from '@/lib/gateway/responses-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleResponses(request)
}
```

- [ ] **Step 5: Answer the unsupported sibling endpoints explicitly**

A bare Next.js 404 says nothing, and a client polling for a stored response
deserves to be told why it will never arrive. Create
`src/app/v1/responses/[id]/route.ts`:

```ts
import { errorResponse, GatewayError } from '@/lib/gateway/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Retrieval, deletion and cancellation are deliberately unimplemented.
 *
 * None of them carries a `model`, and this gateway passes provider response ids
 * through unrewritten, so there is nothing to route on: the id names a
 * conversation on one provider, and the request does not say which. Answering
 * with an explanation beats a bare 404 from the router.
 */
function unsupported(): Response {
  return errorResponse(new GatewayError({
    status: 404,
    type: 'invalid_request_error',
    code: 'unsupported_endpoint',
    message: 'This gateway serves POST /v1/responses only. Retrieving, cancelling or deleting a stored response is not supported, because response ids are passed through from the provider and carry no routing information.',
  }))
}

export const GET = unsupported
export const DELETE = unsupported
export const POST = unsupported
```

Add a test to `tests/gateway/responses-ingress.test.ts`:

```ts
test('retrieval says why it is unsupported rather than 404ing blankly', async () => {
  const { GET } = await import('@/app/v1/responses/[id]/route')

  const res = await GET()
  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('unsupported_endpoint')
})
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/gateway/responses-ingress.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the contract test**

Append to `tests/contract/openai-client.test.ts`, following the file's existing pattern of pointing a real `OpenAI` client at a handler-backed fetch:

```ts
test('the openai SDK can call responses.create against the gateway', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const client = gatewayClient(apiKey, { p1: { respond: async () => response('resp_1') } })

  const result = await client.responses.create({ model: 'house-model', input: 'hi' })

  expect(result.id).toBe('resp_1')
  expect(result.output[0].type).toBe('message')
})

test('the openai SDK can stream responses.create against the gateway', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const client = gatewayClient(apiKey, { p1: { async *respondStream() {
    yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', model: 'up', output: [] } }
    yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
    yield { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', model: 'up', output: [] } }
  } } })

  const seen: number[] = []
  for await (const event of await client.responses.create({ model: 'house-model', input: 'hi', stream: true })) {
    seen.push(event.sequence_number)
  }

  // The SDK parses our framing, and sequence numbers arrive in order.
  expect(seen).toEqual([0, 1, 2])
})
```

If `gatewayClient` does not exist in that file, build the client the way the existing tests there do and extend that helper rather than inventing a second pattern.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add -A
git commit -m "feat(gateway): serve POST /v1/responses"
```

---

# Phase 4 — `responses-to-chat`

The fourth cell. After this, any virtual model can mix flavors freely.

### Task 10: Translate the Responses request into a Chat request

**Files:**
- Create: `src/lib/translate/responses-to-chat.ts`
- Test: `tests/lib/translate/responses-to-chat.test.ts`

**Interfaces:**
- Consumes: `ResponsesRequest` (Task 6), `ChatCompletionRequest` from `@/lib/schemas/chat`.
- Produces:
  ```ts
  export function toChatRequest(req: ResponsesRequest): ChatCompletionRequest
  export function droppedParams(req: ResponsesRequest): string[]
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { droppedParams, toChatRequest } from '@/lib/translate/responses-to-chat'

test('a bare string input becomes one user message', () => {
  expect(toChatRequest({ model: 'm', input: 'hi' }).messages)
    .toEqual([{ role: 'user', content: 'hi' }])
})

test('instructions become a leading system message', () => {
  const { messages } = toChatRequest({ model: 'm', input: 'hi', instructions: 'be terse' })

  expect(messages[0]).toEqual({ role: 'system', content: 'be terse' })
  expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
})

test('input_text and input_image become chat content parts', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'https://x/y.png' },
    ] }],
  })

  expect(messages[0].content).toEqual([
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: 'https://x/y.png' } },
  ])
})

test('an assistant output_text becomes assistant content', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] }],
  })

  expect(messages[0]).toEqual({ role: 'assistant', content: 'sure' })
})

test('a function_call becomes an assistant tool_call', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' }],
  })

  expect(messages[0]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
  })
})

test('consecutive function_calls collapse into one assistant message', () => {
  // Chat Completions represents a parallel call as several tool_calls on one
  // message; leaving them separate would read as two sequential turns.
  const { messages } = toChatRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
    ],
  })

  expect(messages).toHaveLength(1)
  expect(messages[0].tool_calls).toHaveLength(2)
})

test('a function_call_output becomes a tool message', () => {
  const { messages } = toChatRequest({
    model: 'm',
    input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }],
  })

  expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'done' })
})

test('a reasoning item is dropped rather than fed back', () => {
  const req = { model: 'm', input: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] } as never

  expect(toChatRequest(req).messages).toHaveLength(1)
  expect(droppedParams(req)).toContain('input.reasoning')
})

test('tools are un-nested into the chat shape', () => {
  const { tools } = toChatRequest({
    model: 'm', input: 'hi',
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true }],
  })

  expect(tools).toEqual([{
    type: 'function',
    function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
  }])
})

test('a named tool_choice is un-nested too', () => {
  expect(toChatRequest({ model: 'm', input: 'hi', tool_choice: { type: 'function', name: 'f' } }).tool_choice)
    .toEqual({ type: 'function', function: { name: 'f' } })
})

test('text.format becomes response_format', () => {
  const req = { model: 'm', input: 'hi', text: { format: {
    type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true,
  } } }

  expect(toChatRequest(req).response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
  })
})

test('text.format type text sets no response_format at all', () => {
  expect(toChatRequest({ model: 'm', input: 'hi', text: { format: { type: 'text' } } }).response_format)
    .toBeUndefined()
})

test('the scalar parameters map by name', () => {
  const chat = toChatRequest({
    model: 'm', input: 'hi',
    max_output_tokens: 100, reasoning: { effort: 'high' },
    temperature: 0.5, top_p: 0.9, parallel_tool_calls: false, service_tier: 'flex', user: 'u1',
  })

  // max_completion_tokens rather than max_tokens: the latter is deprecated and
  // excludes reasoning tokens on reasoning models.
  expect(chat.max_completion_tokens).toBe(100)
  expect(chat.reasoning_effort).toBe('high')
  expect(chat).toMatchObject({ temperature: 0.5, top_p: 0.9, parallel_tool_calls: false, service_tier: 'flex', user: 'u1' })
})

test('reports the parameters Chat Completions cannot express', () => {
  const dropped = droppedParams({
    model: 'm', input: 'hi',
    truncation: 'auto', include: ['reasoning.encrypted_content'], store: true,
    metadata: { a: 'b' }, max_tool_calls: 3, prompt_cache_key: 'k',
    safety_identifier: 's', reasoning: { effort: 'high', summary: 'auto' },
  })

  expect(dropped.sort()).toEqual([
    'include', 'max_tool_calls', 'metadata', 'prompt_cache_key',
    'reasoning.summary', 'safety_identifier', 'store', 'truncation',
  ])
})

test('reports nothing for a request Chat Completions expresses fully', () => {
  expect(droppedParams({ model: 'm', input: 'hi', temperature: 0.5 })).toEqual([])
})

test('store: false is not reported, because it is what chat does anyway', () => {
  // Reporting an inert value would put a line in the header on nearly every
  // request and bury the ones that changed the answer.
  expect(droppedParams({ model: 'm', input: 'hi', store: false })).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the translator**

Create `src/lib/translate/responses-to-chat.ts`. Head it with a module comment explaining that it holds one round trip — request out and result in — the way `chat-to-responses.ts` holds the other, and that it is pure so it tests without a client. Implement `toChatRequest` per the mappings asserted above, and `droppedParams` returning a sorted list. Follow `chat-to-responses.ts`'s existing conventions for inert values: a field whose value is what Chat Completions does anyway (`store: false`, an empty `include`, an empty `metadata`) is not reported.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/responses-to-chat.ts tests/lib/translate/responses-to-chat.test.ts
git commit -m "feat(translate): translate a Responses request into Chat Completions"
```

---

### Task 11: Reject what cannot be approximated

**Files:**
- Modify: `src/lib/translate/responses-to-chat.ts`
- Test: `tests/lib/translate/responses-to-chat.test.ts`

**Interfaces:**
- Produces: `export function assertServiceable(req: ResponsesRequest, provider: string): void` — throws a non-retryable `ProviderError(400)`.

- [ ] **Step 1: Write the failing test**

```ts
import { assertServiceable } from '@/lib/translate/responses-to-chat'

test.each([
  'web_search', 'file_search', 'code_interpreter', 'image_generation', 'computer_use', 'mcp',
])('rejects the hosted tool %s by name', (type) => {
  // Dropping a hosted tool would answer the request wrongly rather than
  // approximately: the model cannot search, and says so as if it had.
  expect(() => assertServiceable({ model: 'm', input: 'hi', tools: [{ type }] }, 'p1'))
    .toThrow(new RegExp(`${type}.*p1`))
})

test('accepts a function tool', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', tools: [{ type: 'function', name: 'f' }] }, 'p1'))
    .not.toThrow()
})

test('rejects previous_response_id, which a chat provider cannot resolve', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', previous_response_id: 'resp_1' }, 'p1'))
    .toThrow(/previous_response_id/)
})

test('rejects conversation for the same reason', () => {
  expect(() => assertServiceable({ model: 'm', input: 'hi', conversation: 'conv_1' }, 'p1'))
    .toThrow(/conversation/)
})

test('rejects an item_reference input item', () => {
  expect(() => assertServiceable({ model: 'm', input: [{ type: 'item_reference', id: 'msg_1' }] }, 'p1'))
    .toThrow(/item_reference/)
})

test('the rejection is a non-retryable 400', () => {
  // Non-retryable twice over: execute must not replay a doomed request against
  // every target, and recordHealth must not demote a target that is healthy.
  try {
    assertServiceable({ model: 'm', input: 'hi', tools: [{ type: 'web_search' }] }, 'p1')
    expect.unreachable()
  } catch (err) {
    expect(err).toMatchObject({ name: 'ProviderError', status: 400, retryable: false })
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: FAIL — `assertServiceable` is not exported.

- [ ] **Step 3: Implement it**

```ts
/**
 * The rejections, as opposed to the drops.
 *
 * droppedParams covers parameters that shade the answer. These change it: a
 * request asking for web_search against a provider that cannot search is
 * answered wrongly in a way that looks right, which is the one failure mode the
 * "drop and report" rule cannot cover.
 *
 * Non-retryable on purpose. It stops the chain rather than replaying a request
 * every target would refuse, and — because execute only reports health for
 * retryable failures — it cannot open a circuit breaker on a target that is
 * perfectly healthy.
 *
 * `background` is NOT checked here: it is refused for every target, so the
 * ingress schema rejects it at parse time instead.
 */
const HOSTED_TOOLS = new Set([
  'web_search', 'web_search_preview', 'file_search', 'code_interpreter',
  'image_generation', 'computer_use', 'computer_use_preview', 'mcp', 'local_shell',
])

export function assertServiceable(req: ResponsesRequest, provider: string): void {
  const hosted = req.tools?.find((tool) => HOSTED_TOOLS.has(tool.type))
  if (hosted) {
    throw refuse(
      `The \`${hosted.type}\` tool is not available on provider "${provider}", which serves the Chat Completions API. Route this model to a target whose API flavor is "responses".`,
    )
  }

  for (const field of ['previous_response_id', 'conversation'] as const) {
    if (req[field] != null) {
      throw refuse(
        `\`${field}\` is not supported on provider "${provider}", which serves the Chat Completions API and holds no conversation state. Send the full input, or route this model to a target whose API flavor is "responses".`,
      )
    }
  }

  if (Array.isArray(req.input) && req.input.some((item) => item.type === 'item_reference')) {
    throw refuse(
      `An \`item_reference\` input item cannot be resolved on provider "${provider}", which serves the Chat Completions API and holds no conversation state.`,
    )
  }
}

function refuse(message: string): ProviderError {
  return new ProviderError({ status: 400, message, code: 'unsupported_parameter', retryable: false })
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/responses-to-chat.ts tests/lib/translate/responses-to-chat.test.ts
git commit -m "feat(translate): reject Responses features a chat provider cannot approximate"
```

---

### Task 12: Translate the Chat result back into a Response

**Files:**
- Modify: `src/lib/translate/responses-to-chat.ts`
- Test: `tests/lib/translate/responses-to-chat.test.ts`

**Interfaces:**
- Produces: `export function fromCompletion(res: ChatCompletion, req: ResponsesRequest, id: string): ResponsesResult`

- [ ] **Step 1: Write the failing test**

```ts
import { fromCompletion } from '@/lib/translate/responses-to-chat'

const req = { model: 'virtual', input: 'hi' }

function completion(message: Record<string, unknown>, finish = 'stop') {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  } as never
}

test('assistant content becomes a message output item', () => {
  const res = fromCompletion(completion({ content: 'hello' }), req, 'resp_1')

  expect(res.id).toBe('resp_1')
  expect(res.object).toBe('response')
  expect(res.status).toBe('completed')
  expect(res.output).toEqual([{
    type: 'message', id: expect.stringMatching(/^msg_/), role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hello', annotations: [] }],
  }])
})

test('reasoning_content becomes a reasoning item before the message', () => {
  const res = fromCompletion(completion({ content: 'hello', reasoning_content: 'thinking' }), req, 'resp_1')

  expect(res.output[0]).toMatchObject({
    type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }],
  })
  expect(res.output[1]).toMatchObject({ type: 'message' })
})

test('tool calls become function_call items', () => {
  const res = fromCompletion(completion({
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
  }, 'tool_calls'), req, 'resp_1')

  expect(res.output).toEqual([{
    type: 'function_call', id: expect.stringMatching(/^fc_/), call_id: 'call_1',
    name: 'f', arguments: '{"a":1}', status: 'completed',
  }])
  // A tool call is a finished turn, not a truncated one.
  expect(res.status).toBe('completed')
})

test('a length finish becomes incomplete with a reason', () => {
  const res = fromCompletion(completion({ content: 'partial' }, 'length'), req, 'resp_1')

  expect(res.status).toBe('incomplete')
  expect(res.incomplete_details).toEqual({ reason: 'max_output_tokens' })
})

test('usage is restated in the Responses spelling', () => {
  const res = fromCompletion(completion({ content: 'hi' }), req, 'resp_1')

  expect(res.usage).toMatchObject({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })
})

test('the request parameters are echoed back', () => {
  // The real API returns them on the response object, and the request is in
  // hand, so mirroring it costs nothing and improves client fidelity.
  const res = fromCompletion(completion({ content: 'hi' }), {
    model: 'virtual', input: 'hi', instructions: 'be terse', temperature: 0.5,
    tools: [{ type: 'function', name: 'f' }],
  }, 'resp_1')

  expect(res).toMatchObject({
    instructions: 'be terse', temperature: 0.5, tools: [{ type: 'function', name: 'f' }],
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: FAIL — `fromCompletion` is not exported.

- [ ] **Step 3: Implement it**

Build the output array in `output_index` order — reasoning, then message, then function calls — minting `rs_`, `msg_`, and `fc_` ids with `randomUUID()`. Map `finish_reason` per the assertions. Restate usage through the inverse of `usageFromResponses`. Echo `instructions`, `tools`, `tool_choice`, `temperature`, `top_p`, `text`, `reasoning`, `max_output_tokens`, `parallel_tool_calls`, `metadata`, and `user` from the request. Set `created_at` from the completion's `created`, and `model` from the completion's own model — the handler's `finish` overwrites it with the virtual name.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/responses-to-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/responses-to-chat.ts tests/lib/translate/responses-to-chat.test.ts
git commit -m "feat(translate): translate a Chat completion back into a Response"
```

---

### Task 13: Translate the chat chunk stream into Responses events

**Files:**
- Modify: `src/lib/translate/responses-to-chat.ts`
- Test: `tests/lib/translate/responses-to-chat-stream.test.ts`

**Interfaces:**
- Produces: `export async function* fromCompletionStream(chunks: AsyncIterable<ChatCompletionChunk>, req: ResponsesRequest, id: string): AsyncIterable<ResponseStreamEvent>`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { fromCompletionStream } from '@/lib/translate/responses-to-chat'

const req = { model: 'virtual', input: 'hi' }

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up',
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as never
}

async function collect(chunks: unknown[]) {
  const events = []
  for await (const event of fromCompletionStream((async function* () {
    for (const c of chunks) yield c as never
  })(), req, 'resp_1')) events.push(event)
  return events
}

test('opens with created and in_progress before any content', async () => {
  const events = await collect([chunk({ role: 'assistant' }), chunk({ content: 'hi' }, 'stop')])

  expect(events[0].type).toBe('response.created')
  expect(events[1].type).toBe('response.in_progress')
})

test('wraps text deltas in an item and a content part', async () => {
  const events = await collect([chunk({ content: 'he' }), chunk({ content: 'llo' }, 'stop')])
  const types = events.map((e) => e.type)

  expect(types).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
})

test('sequence numbers are monotonic from zero', async () => {
  const events = await collect([chunk({ content: 'hi' }, 'stop')])

  expect(events.map((e) => e.sequence_number)).toEqual([...events.keys()])
})

test('the assembled text arrives on output_text.done', async () => {
  const events = await collect([chunk({ content: 'he' }), chunk({ content: 'llo' }, 'stop')])
  const done = events.find((e) => e.type === 'response.output_text.done')

  expect(done.text).toBe('hello')
})

test('reasoning opens its own item before the message', async () => {
  const events = await collect([
    chunk({ reasoning_content: 'thinking' }),
    chunk({ content: 'hi' }, 'stop'),
  ])
  const added = events.filter((e) => e.type === 'response.output_item.added')

  expect(added[0].item.type).toBe('reasoning')
  expect(added[0].output_index).toBe(0)
  expect(added[1].item.type).toBe('message')
  expect(added[1].output_index).toBe(1)
})

test('tool call deltas become function_call arguments deltas', async () => {
  const events = await collect([
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }),
    chunk({}, 'tool_calls'),
  ])

  const added = events.find((e) => e.type === 'response.output_item.added')
  expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'f' })

  const done = events.find((e) => e.type === 'response.function_call_arguments.done')
  expect(done.arguments).toBe('{"a":1}')
})

test('a length finish ends on response.incomplete', async () => {
  const events = await collect([chunk({ content: 'part' }), chunk({}, 'length')])
  const last = events.at(-1)

  expect(last.type).toBe('response.incomplete')
  expect(last.response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
})

test('usage from the final chunk reaches response.completed', async () => {
  const withUsage = {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up', choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }
  const events = await collect([chunk({ content: 'hi' }, 'stop'), withUsage])

  expect(events.at(-1).response.usage).toMatchObject({ input_tokens: 4, output_tokens: 2 })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/translate/responses-to-chat-stream.test.ts`
Expected: FAIL — `fromCompletionStream` is not exported.

- [ ] **Step 3: Implement the state machine**

Head it with the comment that chat chunks are positional deltas while Responses events are semantic and indexed by `output_index` over *all* items — while `tool_calls[].index` counts only tool calls — so the map between the two is the only state this translator keeps.

The state, in full:

```ts
interface StreamState {
  /** Monotonic across every event the gateway emits, from 0. */
  sequence: number
  /** Counts every output item — reasoning and message included — which is
   *  what output_index means, unlike tool_calls[].index. */
  outputIndex: number
  reasoning: { index: number; itemId: string; text: string } | null
  message: { index: number; itemId: string; text: string } | null
  /** Keyed by the chunk's tool_calls[].index, which is dense over tool calls
   *  only and therefore never equals output_index. */
  toolCalls: Map<number, { index: number; itemId: string; callId: string; name: string; args: string }>
  finishReason: string | null
  usage: LogUsage | null
}
```

Close every open item with its `.done` events — `output_text.done` then `content_part.done` then `output_item.done` for a message, `reasoning_summary_text.done` then `output_item.done` for reasoning, `function_call_arguments.done` then `output_item.done` for each tool call — before emitting the terminal `response.completed` or `response.incomplete`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/responses-to-chat-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/responses-to-chat.ts tests/lib/translate/responses-to-chat-stream.test.ts
git commit -m "feat(translate): translate a chat chunk stream into Responses events"
```

---

### Task 14: Wire the crossing path into the registry

**Files:**
- Create: `src/lib/adapters/wrappers.ts`
- Modify: `src/lib/adapters/registry.ts`, `src/lib/adapters/types.ts` (make the pair required), `src/lib/gateway/protocols/responses.ts` (`droppedFor`, drop `requirePair`)
- Test: `tests/gateway/mixed-flavor.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 10–13.
- Produces:
  ```ts
  export function withRespondViaChat(adapter: ProviderAdapter, providerName: string): ProviderAdapter
  export function withChatViaResponses(adapter: ProviderAdapter): ProviderAdapter
  ```

- [ ] **Step 1: Write the failing test**

Restore the deleted file as a starting point, then extend it:

```bash
git show 23dc469^:tests/gateway/mixed-flavor.test.ts > tests/gateway/mixed-flavor.test.ts
```

Append:

```ts
test('a Responses request is served by a chat-only target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1' }] })
  const chat = vi.fn().mockResolvedValue(completion('p1'))

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({ p1: { chat } }),
  )

  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.object).toBe('response')
  expect(body.output[0].content[0].text).toBe('p1')
  // The chat adapter saw a Chat Completions request, never a Responses one.
  expect(chat.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'user', content: 'hi' }] })
})

test('a Responses request reaches a gemini target through the same wrapper', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', truncation: 'auto' }, apiKey),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem')) } }),
  )

  expect(res.status).toBe(200)
  // Two translation stages, one list: what Responses-to-Chat dropped and what
  // Gemini cannot express are reported together.
  expect(res.headers.get('x-babellm-dropped-params')).toContain('truncation')
})

test('a hosted tool against a chat-only target is a 400 that does not fail over', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'p1' }, { name: 'p2', apiFlavor: 'responses' }],
  })
  const respond = vi.fn()

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', tools: [{ type: 'web_search' }] }, apiKey),
    fakeAdapterByProvider({ p1: { chat: vi.fn() }, p2: { respond } }),
  )

  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.error.message).toContain('web_search')
  // Non-retryable: the chain stops rather than replaying against p2. This is the
  // documented limitation in section 9 of the spec, asserted so it stays a
  // decision rather than becoming an accident.
  expect(respond).not.toHaveBeenCalled()
})

test('a chat request still reaches a responses-flavored target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleChatCompletions(
    chatRequest({ model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }, apiKey),
    fakeAdapterByProvider({ p1: { respond: vi.fn().mockResolvedValue(responsesResult('p1')) } }),
  )

  expect(res.status).toBe(200)
  expect((await res.json()).object).toBe('chat.completion')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/gateway/mixed-flavor.test.ts`
Expected: FAIL — the chat-only target has no `respond`, so the ingress answers 501.

- [ ] **Step 3: Write the wrappers**

```ts
/**
 * The two crossing paths.
 *
 * Applied here, once, rather than implemented per adapter: there are two
 * dialects and four paths, of which two are identity, so exactly two wrappers
 * cover every adapter that will ever exist. A Gemini adapter gets `respond`
 * from the same wrapper the OpenAI chat adapter uses, and never learns that the
 * Responses API exists.
 */
export function withRespondViaChat(
  adapter: ProviderAdapter,
  providerName: string,
): ProviderAdapter {
  return {
    ...adapter,
    async respond(req, ctx) {
      assertServiceable(req, providerName)
      const completion = await adapter.chat(toChatRequest(req), ctx)
      return fromCompletion(completion, req, newResponseId())
    },
    async *respondStream(req, ctx) {
      assertServiceable(req, providerName)
      yield* fromCompletionStream(adapter.chatStream(toChatRequest(req), ctx), req, newResponseId())
    },
  }
}

export function withChatViaResponses(adapter: ProviderAdapter): ProviderAdapter {
  // The Responses adapter already implements chat/chatStream through
  // chat-to-responses.ts, so this side needs no wrapping today. It exists as
  // the named counterpart so the registry reads symmetrically.
  return adapter
}
```

Wire both into `openAIShaped` in `registry.ts`, and wrap `createGeminiAdapter(runtime)` in `withRespondViaChat(…, runtime.name)`. Then make `respond`/`respondStream` **required** on `ProviderAdapter` and delete `requirePair` from `protocols/responses.ts`, replacing the `run`/`runStream` members with direct calls. Set the ingress's `droppedFor`:

```ts
  droppedFor: (candidate, req) => {
    // A Responses-native target expresses everything it is sent; only the
    // crossing path loses anything, and a Gemini target then loses more on top.
    if (candidate.apiFlavor === 'responses') return []
    const chat = toChatRequest(req)
    return [
      ...droppedParams(req),
      ...(candidate.provider.adapter === 'gemini' ? geminiDroppedParams(chat) : []),
    ]
  },
```

Update `fakeAdapterDeps`/`fakeAdapterByProvider` in `tests/helpers/gateway.ts` to stub the two new required methods with the same "not stubbed" throw the existing pair uses.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/gateway/mixed-flavor.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add -A
git commit -m "feat(adapters): serve every ingress from every provider flavor"
```

---

### Task 15: Documentation and the browser check

**Files:**
- Modify: `README.md`
- Verify: the models detail page in a browser

- [ ] **Step 1: Document the ingress**

In `README.md`, beside the existing Chat Completions example, add a Responses one:

```ts
await client.responses.create({
  model: "smart",
  input: "Hello",
  stream: true,
});
```

Then a short "What the Responses API supports" note listing, honestly:

- Stateful follow-ups (`previous_response_id`, `store`) are forwarded to the provider, so they only work reliably when the virtual model has **one** target — the id belongs to the provider that minted it.
- `GET`/`DELETE`/cancel on `/v1/responses/{id}` and `background: true` are not supported.
- Hosted tools (`web_search`, `file_search`, …) need a target whose API flavor is `responses`; against a Chat Completions target the request is refused rather than silently answered without the tool.
- Every other Responses feature works against any target; what a given target could not express is reported in `x-babellm-dropped-params` and in the request log.

Restore the `api_flavor` lines `23dc469` removed from the README (`git show 23dc469 -- README.md`), updating them to say the flavor is set per provider **and** overridable per route target.

- [ ] **Step 2: Run the browser check**

```bash
pnpm dev:test-db
```

Open **http://localhost:3001** (never 3000, never `pnpm dev`). Log in, create a provider and a virtual model with two targets, and confirm: the target dialog shows the API flavor select defaulting to "(inherit — Chat Completions)"; saving `responses` shows a badge on the target row; saving "(inherit)" removes the badge. Stop the server when done.

- [ ] **Step 3: Full verification**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Expected: all clean. `pnpm build` catches route-level type errors the unit suite cannot.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the Responses API ingress"
```

---

## Verification

Before declaring the plan complete, confirm each:

- [ ] `pnpm test` — no fewer than 992 tests, 0 failures
- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — clean
- [ ] `pnpm db:generate` — reports no pending schema changes (the one migration from Task 5 is committed)
- [ ] All four cells covered by a test in `tests/gateway/mixed-flavor.test.ts`
- [ ] `tests/contract/openai-client.test.ts` drives the real SDK at both ingresses
- [ ] The browser check in Task 15 passed
