# Routing Engine — design

**Phase 2.** The gateway currently sends every request to `candidates[0]` and
gives up if that target fails. This phase makes the other targets matter.

## 1. Problem

`resolveVirtualModel` returns every eligible target for a virtual model, ordered
by `(priority, createdAt, id)`. `handleChatCompletions` then uses exactly one of
them:

```ts
// Phase 1 uses the highest-priority target only. Phase 2 walks the list.
candidate = candidates[0]
```

Three consequences follow, and all three are visible to an admin as a broken
promise rather than as a missing feature:

1. **`virtual_models.policy` does nothing.** The column exists, the admin UI
   offers a `<select>` with three options, and every one of them behaves as
   `failover`. Worse, `failover` itself only ever tries its first link.
2. **`route_targets.weight` does nothing.** It is collected on the create and
   edit forms, rendered in the table, and read by nothing.
3. **`virtual_models.max_attempts` does nothing.** It defaults to 3 and there is
   no loop to bound.

A second problem sits behind those: error classification. `classifyProviderError`
recognises `UnsupportedOperationError` and `OpenAI.APIError`, and falls through
to `retryable: true, status: 502` for everything else. Today that is harmless —
the only adapter is OpenAI's, so the fallthrough is unreachable in practice. The
moment a failover loop exists it stops being harmless, and the moment Phase 3
adds a second SDK it becomes actively wrong: a fatal Gemini 400 would be
classified retryable, burn every remaining attempt on a request that cannot
succeed, and reach the client as a 502.

Both Phase 1 and Phase 1.5 handoffs flag this as the thing to decide before
writing Phase 2 code.

## 2. Scope

In scope:

- Policy-driven ordering of the attempt chain: `failover`, `weighted`,
  `round_robin`.
- An attempt loop that fails over on retryable errors and stops on fatal ones,
  bounded by `max_attempts`.
- Error classification moved behind the adapter boundary.
- One structured JSON line per request on stdout, carrying the attempt chain.

Out of scope, deliberately, and each deferred by an explicit decision:

- **Circuit breaking** and the `target_health` table. Deferred whole.
- **`request_logs`, `request_payloads`, and the `/logs` viewer.** Superseded by
  stdout logging until an observability design exists.
- **The `rr_cursors` table.** The round-robin cursor lives in process memory.
- Everything already scheduled for Phase 4: cost, rate limits, budgets, payload
  capture, retention.
- `/v1/embeddings` and `/v1/models` (Phase 3).

**No migration.** Phase 2 adds no table and no column. `drizzle-kit generate`
must not be run.

## 3. Decisions

| Decision | Choice |
|---|---|
| Where errors are classified | Adapters normalise into a shared `ProviderError` before it escapes. |
| Legacy classification | Kept as a fallback, so an unwrapped error still classifies rather than 500ing. |
| Selection purity | `selectOrder` is pure; RNG and cursor are injected. |
| Weighted chain | The whole chain is weighted, not just its head. |
| Zero-weight targets | Sorted last, not dropped. A zero-weight target is a last resort. |
| Round-robin state | In-memory `Map`, one module. |
| Round-robin chain | The eligible list rotated by the cursor. |
| Chain length | `min(maxAttempts, chain.length)`. |
| Exhausted chain | The client gets the **last** classified error, not a generic 502. |
| Client abort | Stops the loop. Never fails over onto a request nobody awaits. |
| Streaming boundary | Unchanged: first chunk commits the response. |
| `UnsupportedOperationError` from a call | Fatal. |
| `UnsupportedOperationError` from `createAdapter` | Retryable — advance to the next target. |
| Request log | One JSON line per request, on settle, to stdout. |

### Why the whole weighted chain is weighted

Weighting only the first pick and then falling back in `(priority, createdAt,
id)` order would mean that under any upstream trouble the traffic distribution
silently collapses onto whichever target happens to sort first. The weights an
admin set would apply only while nothing is failing — which is the case they
least need them for. Repeated weighted picks without replacement cost one extra
pass over a list that is almost always shorter than five.

### Why zero weight is not exclusion

`weight` defaults to 100 and the UI accepts any integer. A target set to `0`
most plausibly means "prefer never" rather than "delete"; excluding it outright
would turn a weight edit into a silent capacity reduction, and if *every* target
were set to zero the model would have no targets at all and return 503. Sorting
zero-weight targets last preserves both intentions.

### Why `createAdapter` failures are retryable

`createAdapter` throws `UnsupportedOperationError` for an adapter type with no
implementation — which today is `gemini` and `bedrock`, i.e. two of the four
values the provider form offers. Treating that as fatal would mean adding a
Gemini target to a virtual model breaks *every* request to that model, including
the ones its healthy OpenAI targets could have served. The failure is a property
of one target, so it is scoped to one attempt.

`UnsupportedOperationError` raised from `chat` or `chatStream` keeps the spec's
fatal semantics: it describes the *operation*, and another provider would only
fail differently.

### Why the last error rather than a generic 502

When a three-link chain exhausts, the interesting fact is *why*. Three
rate-limited providers should surface as `429`; three timeouts as `504`. A
blanket 502 would tell the client only that the gateway is unhappy, and would
turn a retryable condition into one clients handle as a bug.

## 4. Architecture

Five modules, each with one job. The split matters mostly because `select.ts`
being pure is what makes weighted and round-robin testable without a database.

```
src/lib/gateway/
  select.ts      (new)  policy -> ordered attempt chain. Pure.
  rr-cursor.ts   (new)  in-memory round-robin cursor. One Map.
  execute.ts     (new)  the attempt loop.
  request-log.ts (new)  builds and emits the JSON line.
  errors.ts             + ProviderError, classified first.
  chat-handler.ts       shrinks to orchestration.

src/lib/adapters/
  openai/errors.ts (new)  SDK error -> ProviderError.
  openai/index.ts         wraps its call sites.
```

### `select.ts`

```ts
export interface SelectDeps {
  random?: () => number
  nextCursor?: (virtualModelId: string) => number
}

export function selectOrder(
  candidates: Candidate[],   // already eligible, already tie-break ordered
  model: VirtualModelRow,    // policy + maxAttempts + id
  deps?: SelectDeps,
): Candidate[]
```

Returns the chain, truncated. It never queries, never throws, and never mutates
its input.

- `failover` — the input order.
- `weighted` — partition into positive-weight and non-positive-weight. Draw the
  positive group by repeated cumulative-weight pick without replacement; append
  the non-positive group in input order.
- `round_robin` — rotate the input by `nextCursor(model.id) % length`.

### `rr-cursor.ts`

A module-scope `Map<string, number>` and one function that post-increments.
Deliberately its own file: the in-memory choice is correct for a single
instance and wrong for several, and the whole of that decision is five lines to
replace.

Counters are unbounded in principle. In practice one entry per virtual model
using the policy, so no eviction.

### `execute.ts`

```ts
export interface AttemptRecord {
  n: number
  targetId: string
  provider: string
  model: string
  status: number | null      // null when the attempt never got a status
  latencyMs: number
  error?: string
}

export interface ExecuteResult<T> {
  value: T
  candidate: Candidate
  attempts: AttemptRecord[]
}

export async function execute<T>(
  chain: Candidate[],
  requestId: string,
  clientSignal: AbortSignal,
  deps: ChatHandlerDeps,
  run: (adapter: ProviderAdapter, ctx: AttemptContext) => Promise<T>,
): Promise<ExecuteResult<T>>
```

The loop is generic over `run` so streaming and non-streaming share it exactly:
the non-streaming caller passes `adapter.chat`, the streaming caller passes
`(a, ctx) => startChatStream(a.chatStream(req, ctx))`. That is what makes
"failover applies to streams too, up to the first chunk" true by construction
rather than by a parallel code path that has to be kept in step.

Per attempt: build `AttemptContext`, construct the adapter, `run`, record.
On failure, classify.

- Retryable, and attempts remain → record and continue.
- Retryable, chain exhausted → throw the last classified error.
- Fatal → record and throw immediately.
- `clientSignal.aborted` → stop, regardless of classification.

On success the loop returns the value together with the candidate that produced
it, because the response headers (`x-babellm-provider`,
`x-babellm-upstream-model`) name the target that actually served — which under
failover is not the first one tried.

### Error normalisation

```ts
export class ProviderError extends Error {
  readonly status: number
  readonly code: string | null
  readonly type: string
  readonly retryable: boolean
}
```

`classifyProviderError` gains a `ProviderError` branch ahead of everything else
and otherwise keeps its current body. The existing `OpenAI.APIError` branch
stays as a safety net for any call site the adapter refactor misses; it is no
longer the primary path.

The OpenAI adapter's mapping is a straight lift of the logic already in
`classifyProviderError`, moved into `src/lib/adapters/openai/errors.ts` so that
each future adapter has an obvious file to write its own version of.

### Request log

One line, emitted once, when the request settles:

```json
{"lvl":"info","msg":"gateway.request","request_id":"req_a1b2",
 "key":"prod-app","model":"gpt-fast","stream":true,
 "status":200,"latency_ms":1042,"ttft_ms":310,
 "attempts":[
   {"n":1,"provider":"openai","model":"gpt-4o-mini",
    "status":429,"latency_ms":212,"error":"rate_limited"},
   {"n":2,"provider":"groq","model":"llama-3.3-70b",
    "status":200,"latency_ms":830}]}
```

Fields:

| Field | Meaning |
|---|---|
| `request_id` | The `req_…` id already in the `x-request-id` header. |
| `key` | The API key's **name**. Never the key, its prefix, or its hash. |
| `model` | The virtual model name the client asked for. |
| `status` | Final HTTP status. |
| `outcome` | `ok`, `error`, `client_closed`, or `stream_interrupted`. |
| `latency_ms` | Wall clock from handler entry to settle. |
| `ttft_ms` | Streaming only: entry to first chunk. Absent otherwise. |
| `attempts[].status` | Upstream status, or `null` when the attempt never got one. |
| `attempts[].error` | The classified `code`, then `: message`. Absent on success. |

`outcome` exists separately from `status` because a stream that dies after its
first chunk has already sent `200` — the status alone would report it as a
success.

`lvl` is `error` for a 5xx, `warn` for a 4xx, `info` otherwise. Upstream error
text is included, in line with the Phase 1 decision to pass it through verbatim —
this is stdout on a self-hosted gateway, not a client-facing surface.

For a streaming request the line is emitted when the stream closes, so it can
carry `ttft_ms` and report a mid-stream interruption. `sseResponse` gains an
`onSettle(outcome)` callback for this; it fires exactly once, from the `finally`
block that already exists, and on `cancel()` for a client disconnect.

The emitter never throws. A failure to log must not fail a request that
succeeded.

## 5. Request lifecycle after this phase

```
auth → validate → resolve model → select chain → attempt loop → respond → log
```

Steps 1–3 are unchanged. The handler keeps its existing shape and loses its
inline try/catch-per-call-site, which move into `execute`.

## 6. Failure modes

| Condition | Behaviour |
|---|---|
| First target 500s, second succeeds | Client sees 200. Headers name the second. Log carries both attempts. |
| Every target 429s | Client sees 429. |
| First target 400s (bad request) | Client sees 400 immediately. No second attempt. |
| Target's provider is `gemini` | That attempt is skipped; the chain continues. |
| Chain shorter than `max_attempts` | Loop ends at the chain's length. No target is tried twice. |
| Client disconnects mid-chain | Loop stops. Log records the attempts made and a `client_closed` outcome. |
| Upstream fails after first chunk | Stream terminates with an SSE `error` event then `[DONE]`, as today. Log records `stream_interrupted`. |
| All targets disabled | 503 `no_targets_available`, from `resolveVirtualModel`, unchanged. |

## 7. Known limitations

Recorded because they are consequences of decisions made here, not oversights:

- **A hard-down provider is re-attempted on every request.** Failover routes
  around it, but each request still pays one wasted upstream call and its
  timeout before moving on. This is precisely the cost the circuit breaker was
  specified to remove, and it is the strongest argument for building it next.
- **Round-robin distribution skews across instances.** Two processes keep
  independent counters, both starting at zero, so both favour the same target.
  Correct for the single-instance deployment this is being run as; the fix is
  the `rr_cursors` table already described in the gateway spec §4.
- **Round-robin resets on deploy.** In-memory state does not survive a restart.
- **No request history.** Once a line scrolls out of the container log, the
  request is unrecoverable. There is no per-key usage view and no way to answer
  "why was this request slow yesterday".

## 8. Testing

`select.ts` is pure, which is the point of separating it: weighted and
round-robin get exhaustive deterministic tests with an injected RNG and cursor,
including the boundaries of each cumulative-weight bucket, zero and negative
weights, a single-candidate list, and truncation to `max_attempts`.

`execute.ts` gets fake adapters covering fatal-stops, retryable-advances, the
`max_attempts` cap, exhaustion surfacing the last error rather than a generic
one, `createAdapter` failure advancing rather than aborting, client abort
stopping the loop, stream failover before chunk #1, and mid-stream lock-in after
it.

`errors.ts` gets `ProviderError` precedence over the legacy branches, and the
OpenAI adapter gets tests that its SDK errors arrive as `ProviderError` with the
right `retryable` at the 429/499/500 boundaries.

End-to-end coverage goes through the real handler with a fake adapter registry,
as `tests/gateway/*.test.ts` already does. The log line's shape is asserted by
capturing `console.log`.
