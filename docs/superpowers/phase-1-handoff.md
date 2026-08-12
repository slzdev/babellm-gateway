# Phase 1 handoff

**Completed:** 2026-08-12 · 36 commits · 155 tests · `tsc`, `build`, `lint` all clean

Phase 1 delivers a working OpenAI-compatible gateway: authenticated virtual keys,
single-target routing, streaming with tool calls, an OpenAI/openai-compatible
adapter, and an admin dashboard for providers, virtual models, route targets,
users and keys. It is packaged (Dockerfile, `db:deploy`) and deployable.

This document carries forward what the seventeen task reviews and the final
whole-branch review surfaced but deliberately did not fix. It exists because
those findings lived in a git-ignored working directory that has since been
deleted.

## Decide before writing Phase 2 code

**Where provider error classification lives.** `classifyProviderError`
(`src/lib/gateway/errors.ts`) recognises only `UnsupportedOperationError` and
`OpenAI.APIError`; everything else falls through to `retryable: true, status: 502`.
That is harmless today, because the only adapter is OpenAI's. It stops being
harmless the moment Phase 2's failover loop meets Phase 3's Gemini adapter: a
fatal Gemini 400 would be classified retryable, burn every remaining failover
attempt on a request that can never succeed, and reach the client as a 502.

The clean fix is for each adapter to normalise its own errors into a shared
`ProviderError { status, code, message, retryable }` before they escape — moving
classification behind the adapter boundary, where the rest of the
provider-specific knowledge already lives. Deciding this now costs nothing;
discovering it mid-Phase-3 means reworking two adapters and the handler.

## Phase 2 — routing engine

The foundation supports failover, weighted and round-robin selection without
changing `resolveVirtualModel`'s or `startChatStream`'s signatures. The final
review verified this specifically. `Candidate` already carries `priority` and
`weight`; the ordering tie-break (`priority`, `createdAt`, `id`) is what makes
round-robin's "all instances index identically" requirement satisfiable.

Carried-forward items, in rough priority order:

- **`updateRouteTarget` does not exist** — priority and weight can only be changed
  by remove-and-re-add. Acceptable in Phase 1, where only `candidates[0]` is used
  and priority is nearly cosmetic. Phase 2 makes both load-bearing.
- **`decryptJson` does not validate blob structure** before destructuring
  (`src/lib/crypto.ts`), so a corrupted row yields an opaque `TypeError` rather
  than the module's actionable error style. Three lines.
- **`ProviderRuntime.adapter` re-declares the adapter union locally**
  (`src/lib/adapters/types.ts`) instead of deriving from `AdapterType`. Self-checking
  today only because the two lists happen to match.
- **Error-classification coverage gaps:** no test at the 499/500 boundary; the
  "does not leak internals" test asserts only that `postgres://` is absent rather
  than asserting the exact generic message.
- **No test asserts `x-accel-buffering: no`** — the header that stops nginx
  buffering an entire stream. One line.
- **Six caret ranges survive from create-next-app** (`@tailwindcss/postcss`,
  `@types/react`, `@types/react-dom`, `eslint`, `tailwindcss`, `typescript`).
  The lockfile keeps CI reproducible, but the plan's pin-everything rule is
  unfinished.
- **`listProviders` counts route targets in JS** (O(n·m)). Trivial at this scale.
- **The 14-field mapping is duplicated** between `listApiKeys` and `createApiKey`
  (`src/lib/admin/keys.ts`) — real drift risk, ~60 lines apart.
- **`touchApiKey` writes unconditionally on every request.** Fire-and-forget so it
  never delays a response, and Phase 2 adds a `request_logs` insert anyway, but
  gating it on `last_used_at < now() - interval '1 minute'` is nearly free.
- **Nested-passthrough tests cast `Record<string, never>`** in
  `tests/lib/schemas/chat.test.ts` — wrong type, no runtime effect since vitest
  transpiles without type-checking.
- **No automated guard on `route.ts` wiring.** The contract test injects `fetch`
  into `handleChatCompletions` directly, so it never exercises `route.ts`, the
  `runtime`/`dynamic` exports, or Next's header handling. Verified manually
  against a running server; a `next start` smoke test would keep it verified.

## Phase 3 — Gemini and Bedrock adapters

- **`role: "function"` must map to `role: "tool"`.** The request schema accepts
  OpenAI's legacy `function` role (a deliberate compatibility decision — the real
  OpenAI API still accepts it, and older tooling still emits it). The OpenAI
  adapter forwards it verbatim, which is correct. Gemini and Bedrock know nothing
  about it and must translate it exactly like `tool`.
- **Bedrock credential validation reports "Invalid input" with no field name.**
  `validate()` in `src/lib/admin/providers.ts` maps only top-level zod issues and
  does not descend into `invalid_union`'s nested `.errors`, and the Bedrock
  credential schema is a union. Nobody can usefully configure a Bedrock provider
  until this is fixed alongside the adapter.
- **Every adapter must thread `ctx.signal` into every SDK call.** `sseResponse`'s
  `cancel()` now calls `.return()` on the source iterator, but an adapter that
  ignores the signal can still hold an upstream connection open past a client
  disconnect.

## Phase 4 — governance

The schema is ready: `api_keys` already carries `rpm_limit`, `tpm_limit`, both
budgets, `spend_total_usd` and `log_payloads`. The admin UI records them and
states plainly that they are not enforced. `handleChatCompletions` has clean
insertion points between auth and model resolution.

Two known limitations, both documented in the spec and worth re-reading before
implementing: rate limiting uses fixed windows (a 2× burst at the boundary is
possible), and budget checks are pre-request while charges are post-request, so a
key can overshoot by one in-flight request.

## Deliberately not doing

These were raised in review and closed with reasoning:

- **`accessKeyId` is not masked** in the providers table. AWS treats it as an
  identifier, not a secret; only `secretAccessKey` and `sessionToken` are masked.
- **`vitest.config.ts` aliases `server-only` to the package's `empty.js`.**
  That is the same file Next.js resolves under the `react-server` condition, so
  the alias emulates real server context rather than bypassing the guard. It has
  no effect on `next build`.
- **`vitest.config.ts` sets `fileParallelism: false`.** All DB-backed test files
  share one Postgres database reset by `TRUNCATE`; parallel files raced. Revisit
  with transaction-per-test or per-worker schemas only if the suite grows well
  past its current ~5s.
- **`PolicySelect` uses `defaultValue`, not `value`.** Correct for a page that
  revalidates on every mutation.
- **Upstream error text is passed through verbatim** to clients. Useful for
  debugging, consistent with how most gateways behave, and a conscious choice
  rather than an oversight — but it can disclose internal network details such as
  `connect ECONNREFUSED 10.0.0.5:443`.

## Still open after Phase 1

Both were raised by the final review and consciously deferred:

- **No provider credential edit UI.** `updateProvider` is implemented, tested, and
  re-validates credentials when the adapter type changes — but nothing calls it
  except the enable/disable toggle. Rotating a leaked API key currently means
  deleting the provider, which is refused while any route target references it.
  The real procedure today is: remove every target, delete, recreate, re-add.
  During a credential-compromise incident. This should be the first thing built
  in Phase 2.
- **Admin auth hardening.** A single shared password with no attempt limiting;
  `logout()` exists but nothing calls it, so there is no sign-out control;
  rotating `ADMIN_PASSWORD` does not invalidate live sessions, because the token
  signs only the expiry; and `login()`'s length check before `timingSafeEqual`
  leaks the password length by timing. Cheap fixes: hash both sides before
  comparing, mix `sha256(ADMIN_PASSWORD)` into the HMAC key, wire a sign-out
  button, and either add a failed-attempt delay or document that `/login` must sit
  behind a reverse-proxy rate limit.
