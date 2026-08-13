# BabeLLM Gateway — Design

**Date:** 2026-08-11
**Status:** Approved

## 1. Purpose

A self-hosted LLM gateway. It exposes an OpenAI-compatible HTTP API and translates
each request to the native SDK of whichever provider actually serves it. Admins
manage providers, virtual models, and virtual API keys from a web dashboard.

Any OpenAI client works by changing one line:

```ts
new OpenAI({ baseURL: "https://gw.example.com/v1", apiKey: "sk-bab-…" })
```

## 2. Decisions

| Decision | Choice |
|---|---|
| Tenancy | Single tenant, self-hosted. No orgs, no billing. |
| Instances | One or more. All shared state lives in Postgres. |
| Database | PostgreSQL only. Single Drizzle schema, single migration set. |
| Runtime | Docker / `next start` on Node. No serverless constraints. |
| Endpoints | `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`. |
| Adapter architecture | The OpenAI wire format *is* the internal contract. One translation hop. |
| Adapters | `openai`, `openai_compatible`, `gemini`, `bedrock`. |
| Routing policies | Failover chain, weighted, round robin. Circuit breaking on all three. |
| Key controls | Rate limits, spend budgets, expiry, revocation. **No model allowlist.** |
| Users | Label records only. They do not log in. |
| Admin auth | Single shared password from env, signed httpOnly cookie. |
| Credentials | AES-256-GCM at rest, key from `ENCRYPTION_KEY`. |
| Observability | Per-request metadata always; request/response payloads opt-in per key. |

### Explicitly out of scope

Latency- and cost-aware routing. `/v1/responses`. Legacy `/v1/completions`.
Per-key model allowlists. Multi-tenancy. Self-serve user login. SQLite.

## 3. Architecture

One Next.js app, two disjoint surfaces sharing only `lib/db` and `lib/crypto`.
A dashboard bug must never be able to break token streaming.

- **Gateway** — `/v1/*` route handlers. No React, no session auth, no Next caching.
  Authenticated by `Authorization: Bearer <virtual key>`.
- **Dashboard** — `/(admin)/*` App Router pages. Server Components read Drizzle
  directly; Server Actions mutate. Cookie session, guarded by middleware.

```
src/
  app/
    v1/chat/completions/route.ts
    v1/embeddings/route.ts
    v1/models/route.ts
    (admin)/providers|models|keys|users|logs|settings/
    login/
  lib/
    gateway/
      auth.ts        virtual key resolution
      limits.ts      rate limit + budget checks
      router.ts      target selection per policy
      health.ts      circuit breaker
      execute.ts     attempt loop + failover
      cost.ts        price lookup + cost computation
      logging.ts     request log writer
      errors.ts      OpenAI error envelope + classification
    adapters/
      types.ts       ProviderAdapter interface
      registry.ts    adapter type -> factory
      openai/  gemini/  bedrock/
    schemas/         zod contracts for the OpenAI wire format
    db/              drizzle schema + client
    crypto.ts        AES-256-GCM
```

### Adapter interface

```ts
interface ProviderAdapter {
  chat(req: ChatCompletionRequest, ctx: AttemptContext): Promise<ChatCompletionResponse>
  chatStream(req: ChatCompletionRequest, ctx: AttemptContext): AsyncIterable<ChatCompletionChunk>
  embed(req: EmbeddingsRequest, ctx: AttemptContext): Promise<EmbeddingsResponse>
}
```

`AttemptContext` carries the resolved upstream model name, decrypted credentials,
an `AbortSignal`, and the timeout. Adapters are pure translation — they know
nothing about routing, keys, budgets, or logging.

Unsupported operations throw a typed `UnsupportedOperationError` (for example,
embeddings on an xAI provider), which the gateway surfaces as a clear error
rather than a failover attempt.

## 4. Data model

All tables are Postgres. Timestamps are `timestamptz`. Primary keys are uuid
unless noted.

**`providers`** — `name` (unique), `adapter` enum (`openai` | `openai_compatible`
| `gemini` | `bedrock`), `base_url` nullable, `credentials` encrypted blob,
`config` jsonb, `enabled`, timestamps.

Credential shapes are validated per adapter by its own zod schema before
encryption:

- `openai` — `{ apiKey, organization?, project? }`
- `openai_compatible` — `{ apiKey, baseUrl }`
- `gemini` — `{ apiKey }`
- `bedrock` — `{ region, accessKeyId, secretAccessKey, sessionToken? }`
  or `{ region, useInstanceRole: true }`

**`virtual_models`** — `name` (unique; this is what clients send as `model`),
`description`, `policy` enum (`failover` | `weighted` | `round_robin`),
`max_attempts` default 3, `enabled`.

**`route_targets`** — `virtual_model_id`, `provider_id`, `upstream_model`,
`priority` int, `weight` int, `enabled`.

**`target_health`** — PK `target_id`. `consecutive_failures`,
`state` enum (`closed` | `open` | `half_open`), `opened_at`, `next_probe_at`,
`updated_at`. In the DB so every instance agrees.

**`rr_cursors`** — PK `virtual_model_id`, `cursor` bigint. Advanced with
`UPDATE … SET cursor = cursor + 1 … RETURNING cursor`.

**`users`** — `name`, `email` nullable, `notes`. Labels only; no credentials.

**`api_keys`** — `key_hash` (sha256, unique index), `key_prefix` for display,
`name`, `user_id` nullable, `enabled`, `expires_at` nullable, `last_used_at`,
`rpm_limit` nullable, `tpm_limit` nullable, `budget_total_usd` nullable,
`budget_monthly_usd` nullable, `spend_total_usd` numeric default 0 (denormalized
lifetime spend, so the budget check never aggregates), `log_payloads` bool
default false.

**`key_usage_monthly`** — PK (`api_key_id`, `period` `YYYYMM`). `spend_usd`
numeric, `prompt_tokens`, `completion_tokens`, `requests`. Upserted after each
request; makes the budget check a single indexed read.

**`rate_windows`** — PK (`api_key_id`, `kind` `rpm`|`tpm`, `window_start`).
`count` bigint. Fixed window, atomic upsert. Old rows pruned by retention.

**`model_prices`** — `provider_id` nullable + `model` (nullable provider means a
default for that model name across providers), `input_per_mtok`,
`output_per_mtok`, `cached_input_per_mtok` nullable. Seeded, editable in the UI.

**`request_logs`** — `id`, `created_at`, `api_key_id`, `virtual_model_id`,
`virtual_model_name` (denormalized so history survives renames), `stream` bool,
`status_code`, `error_type`, `error_message`, `attempts` jsonb (array of
`{target_id, provider, model, status, latency_ms, error}`), `final_target_id`,
`prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`,
`cost_usd` nullable, `latency_ms`, `ttft_ms` nullable.

**`request_payloads`** — PK `request_log_id`. `request_json`, `response_json`.
Separate table so the hot log table stays small; written only when the key opts
in; pruned by the retention job.

> Superseded by
> [`docs/superpowers/specs/2026-08-13-request-logs-design.md`](2026-08-13-request-logs-design.md):
> `request_payloads` was deleted, and the payload columns live on `request_logs`
> itself; retention drops whole monthly partitions rather than pruning rows.

**`settings`** — key/value jsonb for retention days, default timeouts, breaker
threshold and cooldown.

## 5. Request lifecycle

```
auth → validate → resolve model → rate limit → budget → select targets → attempt loop → log
```

1. **Auth.** sha256 the bearer token, one indexed lookup on `key_hash`. Checks
   `enabled` and `expires_at`. `401` otherwise.
2. **Validate.** zod parse of the body. Failures return the OpenAI envelope
   `{error:{message,type,param,code}}` with `type: "invalid_request_error"`.
3. **Resolve model.** Virtual model by name; unknown → `404 model_not_found`.
4. **Rate limit.** `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
   RETURNING count` on `rate_windows`. Over limit → `429` + `Retry-After`.
   Fixed windows permit a 2× burst at the boundary; accepted, because sliding
   windows would require Redis.

   `rpm` increments before the call. `tpm` cannot: token counts are only known
   afterwards, so the tpm window is *read* before the call (reject if the current
   window already exceeds `tpm_limit`) and *incremented* after with the actual
   total. A single request can therefore push a window past its limit; it is the
   next request that gets rejected.
5. **Budget.** One read of the key's `spend_total_usd` and its current
   `key_usage_monthly` row. Over either → `429 insufficient_quota`.
   **Known limitation:** the check is
   pre-request and the charge is post-request, so a key can overshoot by one
   in-flight request. Reservation-and-settle is not worth the complexity here.
6. **Select targets.** Eligible = enabled, provider enabled, breaker not open
   (or open but past `next_probe_at`). Ordered by policy:
   - `failover` — `priority` ascending.
   - `weighted` — cumulative-weight pick. No shared state needed.
   - `round_robin` — atomic cursor tick, then `cursor % eligible.length`.
     Eligible targets are sorted by id so all instances index identically. The
     list length changes as targets are ejected; the resulting drift is accepted.

   In every policy, the targets not chosen first form the failover chain in
   policy order, capped at `max_attempts`.
7. **Attempt loop.** Below.
8. **Log.** Below.

### Attempt loop and error classification

Each attempt receives an `AbortSignal` bound to the provider timeout. Errors are
classified:

- **Retryable** — connection failure, timeout, `429`, `500`–`504`, provider
  overload. Record the attempt, increment `target_health`, advance to the next
  target.
- **Fatal** — `400` invalid request, context length exceeded, content filter,
  `UnsupportedOperationError`. Returned to the client immediately; another
  provider would only fail differently.

### Streaming failover boundary

The HTTP response is not committed until the upstream yields its **first chunk**.
The loop pulls chunk #1 inside the try block:

- Throw before chunk #1 → ordinary failover; the client never observes it.
- Chunk #1 in hand → headers are sent and the target is locked in. A later
  mid-stream error can only terminate the stream: emit a final SSE `error`
  event, then `[DONE]`, and log `stream_interrupted`.

This is a property of SSE, not a shortcut.

### Circuit breaker

`consecutive_failures >= threshold` (default 5) opens a target for a cooldown
(default 30s) and sets `next_probe_at`. Past that the target is half-open and the
next request probes it: success resets to closed, failure re-opens. With multiple
instances several may probe simultaneously. Harmless, and preferable to locking.

### Response identity

The `model` field in responses reports the **virtual** model name the client
requested, and `id` is a gateway-generated `chatcmpl-…`. The real provider and
upstream model are returned in `x-babellm-provider` and
`x-babellm-upstream-model` headers, alongside `x-request-id`, and recorded in the
log. Clients stay decoupled from routing.

## 6. Provider translation

### openai / openai_compatible

Near passthrough. Unknown parameters are forwarded, so xAI's `search_parameters`
and similar provider extensions work without gateway changes.
`openai_compatible` covers xAI, Groq, Together, DeepSeek, vLLM and Ollama — xAI
publishes no TypeScript SDK and directs users to the OpenAI SDK with a different
`baseURL`.

### gemini (`@google/genai`)

- System message → `systemInstruction`; remaining messages → `contents` with
  roles `user` / `model`.
- `tools` → `functionDeclarations`. **JSON Schema must be sanitized** — Gemini
  rejects `additionalProperties`, `$schema`, and several `format` values. This is
  a known source of silent 400s and gets dedicated tests.
- `tool_choice` → `toolConfig.functionCallingConfig`.
- `response_format: json_schema` → `responseMimeType` + `responseSchema`.
- `max_tokens` → `maxOutputTokens`; `stop` → `stopSequences`.
- Image content: data URIs → `inlineData`. **HTTP image URLs must be fetched and
  inlined** by the adapter; Gemini will not fetch them.
- Finish reasons: `STOP` → `stop`, `MAX_TOKENS` → `length`, `SAFETY` →
  `content_filter`.
- Usage: `usageMetadata`, with `thoughtsTokenCount` → `reasoning_tokens`.
- Function calls arrive complete rather than streamed, so the adapter emits one
  `tool_calls` delta carrying the full arguments. This is spec-legal.

### bedrock (`@aws-sdk/client-bedrock-runtime`)

Uses **Converse / ConverseStream**, not `InvokeModel`. Converse provides one
uniform messages + `toolConfig` shape across Anthropic, Nova, Llama and Mistral,
so the translation is written once rather than per model family.

Stream events map directly: `contentBlockStart` (toolUse) opens a tool call,
`contentBlockDelta` carries text or partial tool-input JSON, `messageStop` gives
`stopReason`, `metadata` gives usage.

### Embeddings

- OpenAI — native.
- Gemini — `embedContent`.
- Bedrock — Converse has no embeddings equivalent, so the adapter uses
  `InvokeModel` with **per-model request bodies**; Titan and Cohere shapes are
  supported.
- xAI / openai_compatible providers without an embeddings endpoint throw
  `UnsupportedOperationError`.

## 7. Cost and logging

Cost is `tokens × price` resolved from `model_prices` by (provider, upstream
model), falling back to a provider-agnostic row for that model name. **When no
price row matches, `cost_usd` is `null`** and the dashboard marks the request
*unpriced* — never a silent zero.

Logging happens after the response completes, including for streams, flushed on
stream close. A client disconnect still writes a row marked `client_closed` with
whatever tokens were counted. The same write updates `spend_total_usd` and
`key_usage_monthly`.

Payload capture is per key. Retention runs as an in-process interval timer
started at boot — the Node runtime makes this safe — pruning `request_payloads`,
`request_logs` and `rate_windows` beyond the configured window. It takes a
Postgres advisory lock first, so exactly one instance prunes regardless of how
many are running.

> Superseded by
> [`docs/superpowers/specs/2026-08-13-request-logs-design.md`](2026-08-13-request-logs-design.md)
> for `request_logs`/`request_payloads`: retention there drops expired monthly
> partitions outright rather than pruning individual rows. `rate_windows` row
> pruning is unaffected by that change.

## 8. Dashboard

| Page | Contents |
|---|---|
| Providers | List, create/edit with an adapter-specific credential form. **Test connection** performs a real cheap upstream call and surfaces the actual error. Delete blocked while route targets reference it. |
| Virtual models | Policy selector plus target table (provider, upstream model, priority, weight, enabled). Live breaker state per row with manual reset. |
| API keys | Creation reveals the full key **exactly once**; thereafter only `sk-bab-a1b2…` + last 4. Limits, budgets, expiry, payload-logging toggle, revoke. |
| Users | CRUD over label records. |
| Logs | Filterable table; detail view shows the attempt timeline with per-target failure reasons, tokens, cost, and payloads when captured. |
| Settings | Retention days, timeouts, breaker threshold, max attempts, model price table. |

Secrets are never returned to the browser after creation. Editing a credential
means re-entering it.

## 9. Testing

The adapter layer is where bugs will live, so tests concentrate there.

- **Translation tests, both directions.** Request side: assert the provider SDK
  was invoked with exactly the expected arguments (vitest mocks;
  `aws-sdk-client-mock` for Bedrock). Response side: replay recorded provider
  stream fixtures and assert the exact OpenAI chunk sequence. Tool-call streaming
  and finish-reason mapping get dedicated cases per provider.
- **Routing unit tests.** Weighted and round-robin selection with injected RNG
  and cursor for determinism; breaker state transitions; error classification.
- **Integration tests.** A fake adapter in the registry driving the real route
  handler: failover before first chunk, mid-stream interruption, auth failures,
  rate limiting, budget rejection, client disconnect.
- **Contract test.** The real `openai` npm client pointed at the running gateway
  with a stubbed provider, exercising streaming and tool calls. This is what
  proves OpenAI compatibility is real rather than aspirational.

Integration and contract tests run against a disposable Postgres database.

## 10. Stack

Next.js 16 (App Router) · React 19 · TypeScript · Drizzle ORM + `pg` ·
PostgreSQL · Tailwind v4 + shadcn/ui · sonner · vitest · pnpm · Docker Compose
for local Postgres.

SDKs: `openai`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`.

## 11. Phasing

Four implementation plans, each ending in something runnable.

1. **Foundation and first real call.** Schema and migrations, crypto, admin
   login, providers/virtual models/keys CRUD, `openai` and `openai_compatible`
   adapters, `/v1/chat/completions` with streaming and tool calling,
   single-target routing.
   *Done when the `openai` SDK talks to it.*
2. **Routing engine.** Failover, weighted, round robin, circuit breaker, attempt
   recording, request logs and the log viewer.
3. **Provider breadth.** Gemini adapter, Bedrock adapter, `/v1/models`,
   `/v1/embeddings`.
4. **Governance.** Rate limits, price table, cost computation, budgets, opt-in
   payload logging, retention pruning, usage charts.
