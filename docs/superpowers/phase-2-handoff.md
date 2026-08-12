# Phase 2 handoff — Routing Engine

**Completed:** 2026-08-13 · 16 commits · 376 tests · `tsc`, `lint`, `build` all clean

Phase 2 makes a virtual model's other targets matter. `policy`, `weight` and
`max_attempts` were columns the admin UI collected and nothing read; they now
drive an attempt chain that the gateway walks until something serves.
Streaming and non-streaming share that one loop, so a stream fails over up to
its first chunk by construction rather than by a parallel code path. Error
classification moved behind the adapter boundary, answering the question both
earlier handoffs said to decide first. Each settled request emits one JSON
line to stdout.

Phase 2 added no table, no column and no migration.

This document carries forward what eight task reviews, three fix rounds and
one adjudicated non-finding surfaced but deliberately did not fix. It exists
for the same reason `phase-1-handoff.md` and `phase-1-5-handoff.md` do.

## Decide before Phase 3 code

**Abort and timeout are misclassified, and the two labels are inverted.**
`AbortSignal.timeout` raises a `DOMException` named `TimeoutError`, not
`AbortError`. The `isAbort` checks in `src/lib/adapters/openai/errors.ts` and
`src/lib/gateway/errors.ts` both test for `AbortError`, so a gateway timeout
falls through to `502 upstream_error`. `AbortController.abort()` — a client
disconnect — *does* produce `AbortError`, so the label is exactly inverted:
that branch would tag a client hangup as `upstream_timeout`.

Neither case reaches those branches anyway. The OpenAI SDK pre-empts both,
throwing `APIUserAbortError` (an `APIError` with `status: undefined`) as soon
as the signal aborts, which matches the `OpenAI.APIError` branch first and
yields `502`. The net effect is that a hung provider and a user pressing stop
both log as `status: 502, outcome: "error", lvl: "error"` — anyone alerting on
`lvl: error` gets paged for ordinary user cancellations. It contradicts spec
§6's `client_closed` outcome and spec §4's "504 for a timeout".
`RequestOutcome`'s `client_closed` is therefore unreachable outside the
post-commit stream path: only `sseResponse`'s `cancel()` ever produces it.

This repo already knows the right answer elsewhere. `src/lib/catalog/sync.ts`
documents exactly this hazard and matches on all three names. Phase 1.5's
catalog path got it right; the Phase 2 request path did not.

The fix belongs in `execute`, not the adapters. `attemptContext` builds the
timeout signal, so it should hand it back and let the loop decide the label
from `clientSignal.aborted` (→ `client_closed`) versus the timeout signal
(→ 504), rather than from the error's class name. Doing that before Phase 3
means one place decides, instead of three `toProviderError` files each
guessing at a different SDK's abort class.

No test caught this because both tests assert the wrong thing.
`tests/lib/adapters/openai/errors.test.ts` feeds a synthetic
`DOMException('aborted', 'AbortError')` the SDK never emits, and
`tests/lib/gateway/errors.test.ts` only asserts `retryable === true` — the
fallback's behaviour for every unrecognised error, so that test passes with
the `isAbort` branch deleted.

**Where provider error classification lives is now answered.** Adapters
normalise their own failures into a shared `ProviderError { status, code,
type, retryable }` before the error escapes. The OpenAI adapter does this in
`src/lib/adapters/openai/errors.ts` (`toProviderError`), wrapping every call
site in `openai/index.ts`. `classifyProviderError` checks `ProviderError`
first and everything else is fallback.

Two consequences for the Gemini and Bedrock adapters:

- **Each new adapter must ship its own `toProviderError` alongside it**, in
  `src/lib/adapters/<name>/errors.ts`, and must wrap every call site. An
  adapter that skips this does not fail loudly — its errors fall through to
  the generic branch, which classifies everything as `retryable: true, status:
  502` and will burn the whole chain on a fatal Gemini 400. That is the exact
  failure both earlier handoffs predicted; the fix is in place but it is
  opt-in per adapter.
- **`classifyProviderError`'s legacy `OpenAI.APIError` branch is now a
  fallback and should be deleted once every adapter wraps its own errors.**
  It duplicates `toProviderError`'s logic verbatim, so the two can drift, and
  while it exists an OpenAI adapter call site that forgot to wrap still
  behaves correctly — which is precisely what stops the omission being
  noticed.

**Per-attempt timeouts have no overall deadline.** Each attempt gets its own
`config.timeoutMs` (default 120s) via `AbortSignal.timeout` in
`attemptContext`. Nothing bounds their sum. The worst-case request is now
`sum(timeoutMs)` over the chain — up to `max_attempts` × 120s — where Phase 1
capped at one 120s attempt. Three hung providers hold a client for six
minutes.

The 360s default worst case is far past every common proxy default (nginx 60s,
ALB 60s), so in a realistic deployment the client's proxy severs the connection
at 60s while `execute` — whose `clientSignal` did not fire, because the proxy
closed the socket and nothing propagated that back — keeps walking the chain
for another five minutes, burning upstream calls and tokens for a response
nobody can receive. Each attempt also arms a fresh `AbortSignal.timeout` that
is never cleared, so those timers stay live for their full duration after the
attempt they belonged to has settled.

This is new behaviour introduced by this phase, and it deserves a deliberate
decision rather than a production discovery. A single request-level deadline
`AbortSignal.any`-ed into every attempt fixes both halves at once.

## Deferred by decision, not oversight

Each of these was an explicit out-of-scope decision in the spec (§2), not
something the work ran out of time for.

### The circuit breaker and `target_health`

Deferred whole: no breaker state, no cooldowns, no probes, no table. The spec
states the cost (§7):

> **A hard-down provider is re-attempted on every request.** Failover routes
> around it, but each request still pays one wasted upstream call and its
> timeout before moving on. This is precisely the cost the circuit breaker was
> specified to remove, and it is the strongest argument for building it next.

Read that alongside the deadline item above: without a breaker, the wasted
call is charged the *full per-attempt timeout*, and the two limitations
compound.

### `request_logs`, `request_payloads`, and the `/logs` viewer

Superseded by stdout logging until an observability design exists. There is no
table, no viewer, and no per-key usage view. The spec's cost (§7):

> **No request history.** Once a line scrolls out of the container log, the
> request is unrecoverable. There is no per-key usage view and no way to
> answer "why was this request slow yesterday".

`src/lib/gateway/request-log.ts` builds the line in one place and
`emitRequestLog` never throws, so redirecting it to a table later is a change
at one call site rather than a rewrite.

### The `rr_cursors` table

The round-robin cursor is a module-scope `Map` in
`src/lib/gateway/rr-cursor.ts`. The spec's cost (§7):

> **Round-robin distribution skews across instances.** Two processes keep
> independent counters, both starting at zero, so both favour the same target.
> Correct for the single-instance deployment this is being run as; the fix is
> the `rr_cursors` table already described in the gateway spec §4.
>
> **Round-robin resets on deploy.** In-memory state does not survive a
> restart.

The module exists to be replaced: it is 34 lines, one `Map`, and `selectOrder`
takes `nextCursor` as an injected dep, so nothing else has to change.

## Carried forward, in rough priority order

### Resource handling

- **An abandoned stream source is not `.return()`-ed before `execute`
  advances.** When `startChatStream` throws on its first pull
  (`src/lib/gateway/sse.ts`), the source generator it was iterating is left
  to the garbage collector, so a real adapter may leak an upstream connection.
  Phase 1 had the same gap; failover makes it happen more often, because
  advancing past a failed stream attempt is now the normal path rather than
  the end of the request. `sseResponse`'s `cancel()` already does the right
  thing for the post-commit case — this is the pre-commit one.

### Correctness of what the log reports

- **A corrupt `provider.config` is recorded as an upstream 502 that never
  happened.** `attemptContext`'s `JSON.parse` sits inside the call's
  try-block in `src/lib/gateway/execute.ts`, so a parse failure is classified
  as a provider error and logged as an attempt against a provider that was
  never contacted. Pre-existing logic, moved verbatim from the Phase 1
  handler; failover makes it worse, because that phantom attempt also consumes
  a link of the chain.

### Dead and over-permissive code

- **The empty-chain 503 fallback in `execute` is unreachable.**
  `resolveVirtualModel` owns the no-targets path and returns 503
  `no_targets_available` before `execute` is ever called. Nothing covers it,
  because nothing can reach it — it reads as a live branch and is not one.
- **`routed()`'s `candidate` parameter is typed optional** but both call sites
  pass one, so `lastProvider` can never actually be null. The `?? null` and
  the nullable field on `RoutedError` exist for a case that cannot occur.

### Comments that say the wrong thing

- **`chat-handler.ts`'s catch block never says why `x-babellm-upstream-model`
  is dropped on errors** while `x-babellm-provider` is kept. The reasoning
  (only the routed error knows which provider was last; there is no single
  upstream model to name) lives in the brief and the commit message, not in
  the file.

### Test-quality gaps

None of these leave a behaviour untested; each is a test that passes for a
weaker reason than it appears to.

- **The latency assertion is near-vacuous** (`execute.test.ts`): a `Date.now`
  delta is always `>= 0`, so a cumulative implementation would pass it too.
- **The client-abort test discriminates only via call count** and never
  asserts *which* error surfaces to the client.
- **`request-log.test.ts`'s `toHaveLength(0)`-before-drain holds by microtask
  ordering, not by a barrier**, and the fixed 10ms/20ms sleeps in `drain()`
  and the disconnect test are the first things in this suite that would flake
  under load.
- **The weighted integration test asserts only the response header.** It could
  also assert a 200 and that the zero-weight target's `chat` was never called.
- **The post-first-chunk streaming test drains the body** without asserting
  that the `stream_interrupted` event actually reached the client.
- **The "top of range" weighted test does not exercise the `index = last`
  fallback** in `weightedOrder`: `0.999999999` still goes negative on the last
  bucket, so the fallback only fires when `roll === total` exactly. This was
  the brief's test design, not the implementer's.
- **No explicit test for a negative `max_attempts`.** It takes the same
  `Math.max(1, …)` path as the tested `0` case.
- **`failover.test.ts` spies `console.log` with no `restoreAllMocks`.**
  Forward scaffolding written for Tasks 7–8; harmless, and now unexplained.
- **Task 8's red checkpoint was skipped.** No test was individually observed
  failing for its own reason before the implementation landed, so that task's
  tests are known to pass but not known to have ever failed.
- **eslint still has no `argsIgnorePattern`.** Task 2's unused `_deps` warning
  went away when Task 3 consumed the parameter, so the symptom is gone and the
  config gap is not.

### Still true from Phase 1

Re-checked against this branch's diff — Phase 2 touched no admin code, no
crypto, and no auth, so all of these stand unchanged:

- **`decryptJson` does not validate blob structure** before destructuring
  (`src/lib/crypto.ts`).
- **`ProviderRuntime.adapter` re-declares the adapter union locally**
  (`src/lib/adapters/types.ts`) instead of deriving from `AdapterType`.
- **No test asserts `x-accel-buffering: no`.** The header is still set in
  `sseResponse`; still nothing pins it.
- **The 14-field mapping is duplicated** between `listApiKeys` and
  `createApiKey` (`src/lib/admin/keys.ts`).
- **`touchApiKey` writes unconditionally on every request.** The Phase 1
  handoff deferred this on the grounds that "Phase 2 adds a `request_logs`
  insert anyway" — that is now false. No per-request write was added, so this
  fire-and-forget UPDATE is the only one, and gating it on `last_used_at <
  now() - interval '1 minute'` is the whole fix.
- **Six caret ranges survive from create-next-app**, against the plan's
  pin-everything rule.
- **`listProviders` counts route targets in JS** (O(n·m)).
- **No automated guard on `route.ts` wiring.** The contract test still injects
  `fetch` into `handleChatCompletions` directly, so `route.ts`, its
  `runtime`/`dynamic` exports and Next's header handling are still only
  verified by hand.
- **Admin auth hardening.** A single shared password with no attempt limiting;
  `logout()` exists but nothing calls it; rotating `ADMIN_PASSWORD` does not
  invalidate live sessions; `login()`'s length check before `timingSafeEqual`
  leaks the password length by timing. Unchanged since Phase 1 and now two
  phases old.

Phase 1's error-classification coverage gap is **closed**:
`tests/lib/adapters/openai/errors.test.ts` now pins the 429/499/500
boundaries. Phase 1's `updateRouteTarget` gap was closed in Phase 1.5.

### Still true from Phase 1.5

Phase 2 touched none of the catalog or admin code, so every item in the Phase
1.5 handoff still stands. The three concurrency defects are the ones worth
re-reading, because they destroy or corrupt hand-entered data rather than
merely being slow:

- **Override edits are a three-statement read-modify-write** with no
  transaction and no row lock (`src/lib/admin/catalog.ts`). Two concurrent
  override edits lose one outright.
- **`remerge()` does not consult `registryEnabled`**, so editing an override
  on a row synced while the registry was off re-applies stale registry values.
- **`providers.config` is also a read-modify-write**, so two admins saving
  concurrently can lose one namespace edit.

Also still open: the Bedrock credential rejection that surfaces as the bare
string `Invalid input`, and the two silent `useInstanceRole` failures. All
three become reachable the moment Phase 3 gives Bedrock an adapter, and Phase
2 made Bedrock targets *routable* — `createAdapter` failure now skips the
target instead of failing the request, so a misconfigured Bedrock target in a
chain is silently invisible rather than loudly broken.

## Never verified

- **No failover has been exercised against two real providers.** Every
  failover, execute and selection test uses fake adapters or an injected
  `createAdapter`. What the tests prove is that the loop advances, stops and
  reports correctly given errors of a given shape; what nobody has watched is
  a real OpenAI 429 handing off to a real Groq endpoint mid-request. **Do this
  first:** configure two providers with real credentials, one virtual model
  with a target on each, revoke or throttle the first, and confirm the client
  gets a 200 with `x-babellm-provider` naming the second.
- **The stdout line has never been read by a log aggregator.** Its shape is
  asserted by capturing `console.log` and parsing the string back, which
  proves it is valid JSON and nothing more. It has never been through Loki,
  CloudWatch, Vector or `jq` in a real pipeline, so nothing has exercised the
  fields' names against a real query, the line length against a broker's
  limit, or the behaviour when a multi-line upstream error message is embedded
  in `attempts[].error`.
- **Round-robin has only ever run in one process.** The skew described in the
  spec is reasoned about, not observed. Nothing has been deployed at more than
  one instance at any point in this project.
- **The client-abort path has never seen a real socket close.** Tests drive it
  with a synthetic `AbortSignal`. `client_closed` reaching the log line
  because a browser hung up mid-chain is untested end to end.
- **The per-attempt timeout has never accumulated.** No test drives a chain of
  hung providers to the multi-minute worst case described above, so that
  number is arithmetic rather than a measurement.
- **No component tests anywhere in the UI** (carried from Phase 1.5), and the
  model picker still needs a human to click it — see that handoff's
  "Click this first" list, which nothing in Phase 2 addressed.

## Deliberately not doing

- **The `AGENTS.md` "Implementation workflow" section stays where Task 4
  committed it.** A review raised it as Critical scope creep; the premise was
  wrong — the section is the user's own working-tree edit, system-confirmed as
  intentional. Reverting would have deleted the user's work, and bundling it
  into an unrelated commit is a cosmetic complaint with the content preserved
  either way. Adjudicated, not deferred.
- **Zero-weight targets sort last rather than being dropped.** A weight of `0`
  most plausibly means "prefer never", not "delete"; excluding them would turn
  a weight edit into a silent capacity reduction, and an all-zero model would
  have no targets at all (spec §3).
- **An exhausted chain surfaces the last provider's error, not a generic
  502.** Three rate-limited providers should read as `429` and three timeouts
  as `504`. A blanket 502 turns a retryable condition into one clients handle
  as a gateway bug (spec §3).
- **`UnsupportedOperationError` means two different things by origin.** Fatal
  from `chat`/`chatStream` — it describes the operation, and another provider
  would only fail differently. Retryable from `createAdapter` — it describes
  one target, and treating it as fatal would let adding a Gemini target break
  every request to a model its healthy OpenAI targets could serve (spec §3).
- **Upstream error text still passes through verbatim**, into both the client
  response and the stdout line. A conscious Phase 1 decision, restated in the
  spec for the log: this is stdout on a self-hosted gateway, not a
  client-facing surface. It can still disclose internal network detail such as
  `connect ECONNREFUSED 10.0.0.5:443`.
