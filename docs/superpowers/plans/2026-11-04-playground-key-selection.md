# Playground Key Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace pasted gateway credentials with an existing-key picker while preserving each key's enforcement and accounting.

**Architecture:** Server-supplied safe key options feed the existing Playground client. An independently authenticated `/playground/chat` route validates the selected ID and invokes the shared gateway via a server-only key resolver dependency; public Bearer authentication stays unchanged.

**Tech Stack:** Next.js App Router, React, TypeScript, installed shadcn primitives, Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-playground-key-selection-design.md`

## Global Constraints

- Never expose API key hashes or plaintext secrets to the client.
- Public `/v1` authentication must remain Bearer-token-only.
- Every Playground execution requires a valid admin session and same-origin access checks.
- The selected key is revalidated on each request and owns all accounting and logging.
- Test and browser traffic uses only disposable Postgres on port 5434; browser checks use port 3001.
- Preserve the existing model selector readability, full-width layout, streaming and cancellation behavior.

## Review Focus

- Forged key IDs/Bearer headers must not bypass either the public gateway or Playground session/origin checks (Task 1 tests).
- Keys disabled, expired, deleted or modified after page load must be rechecked, not trusted from page props (Task 1 tests).
- Usage, budgets/rate limits, last-used timestamps and optional captured payloads must belong to the selected key, including SSE (Task 1 tests).
- AbortSignal, streaming Response and metadata must survive the admin bridge without buffering (Task 1 tests and browser check).
- No keys and duplicate names need an understandable picker; changing selection resets context (Task 2 tests/browser check).

---

### Task 1: Safe key options and admin chat bridge

**Files:**
- Modify: `src/lib/gateway/auth.ts`
- Modify: `src/lib/gateway/handler.ts`
- Modify: `src/lib/admin/playground.ts`
- Create: `src/lib/admin/playground-handler.ts`
- Create: `src/app/(admin)/playground/chat/route.ts`
- Modify/test: `tests/lib/gateway/auth.test.ts`, `tests/lib/admin/playground.test.ts`
- Create/test: `tests/lib/admin/playground-handler.test.ts`

**Interfaces:**
- Export `PlaygroundApiKeyOption = { id: string; name: string; keyPrefix: string; userName: string | null }` and `listPlaygroundApiKeys(): Promise<PlaygroundApiKeyOption[]>` from the admin helper. Query only safe fields, enabled keys, and expiry strictly later than now (or null); sort by name with stable tie-breaker.
- Export `resolveApiKeyById(id: string): Promise<ApiKeyRow>` from auth; share disabled/expiry validation with Bearer lookup without changing existing public errors. Unknown ID rejects as `invalid_api_key`.
- Extend `GatewayDeps` with optional `resolveKey?: (request: Request) => Promise<ApiKeyRow>`. In the gateway try/catch, use this when present; otherwise use existing Bearer resolution. All later lifecycle logic stays shared.
- Export `handlePlaygroundChat(request: Request, deps?: PlaygroundHandlerDeps): Promise<Response>` from the new server-only admin handler. `PlaygroundHandlerDeps` contains `isAuthenticated: () => Promise<boolean>` and `createAdapter: GatewayDeps['createAdapter']`, defaulted to existing production functions. This is a test seam; the normal route passes no deps.
- Route POST delegates to that handler, `runtime='nodejs'`, `dynamic='force-dynamic'`.
- Request JSON is `{ apiKeyId: UUID, ...ordinaryChatFields }`; response is the untouched gateway Response.

- [x] Read installed Next route-handler docs, existing gateway deps/auth/error/logging test helpers, and TDD guidance before code. Controller owns full-suite and service management; run focused tests serially.
- [x] Write tests and observe behavioral RED for key-list safe projections, duplicate names, disabled/expired/no keys, ID resolution and revalidation; anonymous session401, bad/missing/cross-site Origin403, valid/proxied origins, malformed JSON/ID400, missing/deleted/disabled/expired key401; public gateway refuses a selected key ID without a valid Bearer token.
- [x] Write lifecycle tests with real DB and fake adapter: selected key differs from supplied Bearer key and owns logs, usage and lastUsedAt; limits reject; payload capture follows selected key; SSE remains incremental and carries metadata; key-ID field is stripped and source tag controlled by server; forwarded signal observes cancellation. Verify actual outcomes, not only mocks.
- [x] Implement minimal shared validation/resolver and handler. Validate access before parsing body or touching keys. Use existing `GatewayError`, `errorResponse`, `readJson`, and `parseWith` conventions. Same-origin logic follows spec including forwarded host and fetch metadata; require HTTP(S) Origin without a path. Validate UUID before DB lookup, strip ID, construct forwarded Request with JSON body and original signal, controlled source tag, then use handleChatCompletions with chosen-key resolver and adapter factory.
- [x] Run focused tests, relevant lint/typecheck, self-review and commit only Task 1 files. Report RED/GREEN evidence, exact commands and remaining concerns.

### Task 2: Existing-key picker and request integration

**Files:**
- Modify: `src/app/(admin)/playground/page.tsx`
- Modify: `src/app/(admin)/playground/playground.tsx`
- Modify: `src/lib/playground/request.ts`
- Modify: `tests/lib/playground/request.test.ts`
- Modify: `README.md` and original `docs/superpowers/specs/2026-11-04-playground-design.md` to reflect current behavior and link the new key-selection design.

**Interfaces:**
- Consume `PlaygroundApiKeyOption`, `listPlaygroundApiKeys()` from Task 1.
- Client signature `Playground({ models, apiKeys }: { models: PlaygroundModelOption[]; apiKeys: PlaygroundApiKeyOption[] })`.
- Rename `PlaygroundSettings.apiKey` to `apiKeyId`; `buildPlaygroundRequest(...)` returns `{ apiKeyId: string; body: ChatRequest }`. Trim/require ID, keep all other validation/history unchanged.

- [x] Update request tests first for selected key IDs, missing selection, and unchanged history/numeric settings; observe relevant RED.
- [x] Load model/key options concurrently after requireAdmin. Replace password field with installed shadcn Select or Combobox, showing key name, prefix, optional owner and API keys link. Default first eligible key; disable while busy. On selection change clear history/stats/draft with existing newConversation behavior. If no usable keys, show actionable empty copy and disable send, preserving model controls.
- [x] Fetch `/playground/chat` with `credentials:'same-origin'`, JSON `{ ...requestBody.body, apiKeyId: requestBody.apiKeyId }`, and existing AbortSignal. Remove Authorization and browser source tag (server sets it). Preserve stream reader, cancellation guards, model popup/layout and all returned metadata. Update send gating and copy to selected-key behavior.
- [x] Update README/current design to remove obsolete pasted-secret instructions, describe admin-session execution under selected key with its normal usage/limits/logs, and preserve memory-only conversation wording.
- [x] Focused tests/lint/typecheck, self-review and scoped commit. No shallow static markup tests; controller verifies actual picker interaction in browser.

## Final verification

- [x] Independent task reviews, then full tests, lint/typecheck/build, disposable fake-provider browser checks (two keys, selection reset, SSE/JSON, Stop, empty keys and stale revoked key).
- [x] Whole-change review and necessary corrections. Keep `codex/playground` as already selected by the user; no merge or PR unless requested.

## Verification results

Verified 2026-11-04: full suite passes 148 files / 2,041 tests; lint, typecheck, production build and independent reviews pass. Disposable browser checks covered default/alternate key selection, conversation reset, SSE/JSON, selected-key log attribution and payload capture policy, revoked-key refusal before provider execution, no-active-key state and Send gating, and Stop/cancellation. Real signed-session requests also verified anonymous/cross-origin refusal and unchanged public Bearer authentication. Test and browser databases remained on port 5434; upstream calls used a localhost fake provider. Retained codex/playground per the user’s existing integration choice.
