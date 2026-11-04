# Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins chat with configured virtual and direct catalog models from a new Playground page.

**Architecture:** A server page supplies a credential-free list of eligible models to a shadcn client interface. The browser calls the existing gateway using a pasted API key and reads chat responses using a small tested helper.

**Tech Stack:** Next.js 16.3 App Router, React 19, TypeScript, shadcn/base-ui, Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-playground-design.md`

## Global Constraints

- Build in the existing Next.js App Router, React, TypeScript, and shadcn/ui stack.
- Add `/playground` to the existing admin sidebar and require the admin session on the page.
- Send requests to the existing `/v1/chat/completions` endpoint with a user-supplied gateway API key; preserve routing, key limits, cost, usage, logging, and error behavior.
- Keep the API key and conversation only in client component memory; never save them to browser storage, URLs, or a new database table.
- Never run tests or browser checks against Postgres on 5432; use the disposable Postgres on 5434 and `pnpm dev:test-db` on port 3001.
- Preserve the pre-existing `package.json` change to the `dev` script.

## Review Focus

- Split UTF-8/CRLF frames and usage-only final chunks must survive the stream reader (Task 1 tests).
- HTTP failures, in-stream errors, and premature EOF must produce visible failure, preserving partial content (Task 1 tests, Task 2 browser check).
- Disabled providers/targets, known non-chat entries, slash-containing model IDs, and virtual shadowing must yield usable options (Task 1 database tests).
- Stop, reset, and unmount must prevent stale responses from changing the conversation; failed turns must not pollute follow-up history (Task 2 request tests and browser check).
- Empty configuration, absent usage/cost, and invalid optional parameters must have useful states without inventing measurements or sending invalid input (Task 2 tests and browser check).

---

### Task 1: Model options and chat response reader

**Files:**
- Create: `src/lib/admin/playground.ts`
- Create: `src/lib/playground/stream.ts`
- Test: `tests/lib/admin/playground.test.ts`
- Test: `tests/lib/playground/stream.test.ts`

**Interfaces:**
- Produce `PlaygroundModelOption = { value: string; label: string; group: string }` and `listPlaygroundModels(): Promise<PlaygroundModelOption[]>` in the admin helper. Groups are `Virtual models` and provider names. Sort virtual first, then provider/model. Only return these three safe strings.
- Produce `PlaygroundUsage` with optional `prompt_tokens`, `completion_tokens`, `total_tokens`, and `cost?: { total: string | null } | null`.
- Produce `PlaygroundStreamEvent = { type: 'delta'; content: string; reasoning: string } | { type: 'usage'; usage: PlaygroundUsage } | { type: 'finish'; reason: string }` and `readChatResponse(response: Response): AsyncGenerator<PlaygroundStreamEvent>` in the stream helper. Support both streamed SSE and nonstream JSON responses.

- [ ] Write model-list tests covering available virtual/direct models, disabled providers/targets/models, known non-chat versus unknown catalog kinds, empty configuration, virtual shadowing, missing entries, and slash-containing upstream IDs. Read existing DB fixture patterns.
- [ ] Write reader tests using actual Response/ReadableStream objects. Cover content and reasoning deltas, split UTF-8 and CRLF boundaries, usage-only chunks, non-stream JSON, HTTP errors, SSE error envelopes, malformed data, and EOF without `[DONE]`.
- [ ] Run the focused tests and record expected failures before implementing. Test configuration must come from `.env.test.example` on port 5434; controller owns database setup and full-suite execution to avoid concurrent DB resets.
- [ ] Implement the helpers. Use TextDecoder streaming, preserve event boundaries, release/cancel stream readers, throw helpful gateway messages on HTTP/SSE errors. Never import server-only modules into the stream helper. Model eligibility follows the spec; enabled virtual names shadow direct addresses even when the virtual option has no usable chat target.
- [ ] Run focused tests and lint of changed files; self-review and commit only this task's files. Report test evidence and any questions to the controller.

### Task 2: Playground page and conversation UI

**Files:**
- Create: `src/app/(admin)/playground/page.tsx`
- Create: `src/app/(admin)/playground/playground.tsx`
- Create: `src/lib/playground/request.ts` (request/history validation, if needed to keep state behavior testable)
- Modify: `src/app/(admin)/layout.tsx`
- Modify: `README.md` (brief Playground usage paragraph)
- Test: `tests/lib/playground/request.test.ts` if request helper is used

**Interfaces:**
- Consume `PlaygroundModelOption`, `listPlaygroundModels`, `PlaygroundUsage`, and `readChatResponse` from Task 1 exactly as exported.
- Produce a force-dynamic server page with `requireAdmin()` and a client `Playground({ models }: { models: PlaygroundModelOption[] })`.

- [ ] Read installed Next.js guides for layouts/pages, server/client components and relevant route behavior, plus existing shadcn combobox/card/input/switch APIs before coding.
- [ ] Write and run failing behavioral request tests for optional numeric settings, system prompt, multi-turn context, and exclusion of failed/stopped assistant turns. Do not write shallow render or implementation-mirroring tests for static markup.
- [ ] Build the responsive settings/conversation layout from installed shadcn primitives. Implement the controls and state transitions specified in the design. A local conversation renderer has no shadcn equivalent. Use native form validation plus JS validation where request construction needs it; blank optional numbers are omitted. Use `max_completion_tokens` for the token cap.
- [ ] Send same-origin fetches to `/v1/chat/completions`, `Authorization: Bearer <trimmed key>`, `Content-Type: application/json`, `x-babellm-tags: source=playground`, and AbortController.signal. Request usage on streamed requests. Keep all secrets in React state. Display returned routing/request headers, errors, reasoning, available usage/cost, dropped parameters, and elapsed time.
- [ ] Keep in-flight state synchronized with a ref/controller so double submits and old request callbacks are guarded. Stop aborts and preserves partial output as incomplete. New conversation clears history/error/stats and draft while preserving configuration. Successful context contains only completed user/assistant pairs; the current failed prompt can be retried without adding an unmatched duplicate. Changing model starts a clean conversation.
- [ ] Add sidebar link near Dashboard and README instructions mentioning gateway key, normal usage/limits/logs, and memory-only conversation. Use safe links to `/keys`, `/providers`, `/models`, and `/logs/<request-id>` as applicable.
- [ ] Run focused tests, lint, and typecheck; self-review and commit only this task's files. Controller performs production build/full suite and browser verification with a disposable fake provider.

## Controller verification and finish

- [ ] Task-scoped review after each task and fix confirmed defects through its implementer.
- [ ] Full test suite on the disposable database, lint, typecheck, production build.
- [ ] Browser check via `pnpm dev:test-db` on port 3001 with a locally mocked provider in the disposable DB: empty state, model selection, send/stream, follow-up context, errors, Stop/reset, and narrow layout. Do not use the existing developer server on port 3000.
- [ ] Whole-branch review and required fixes, then recheck affected behavior.
- [ ] Ask how to integrate per AGENTS.md: merge into main, keep branch, or branch + PR.
