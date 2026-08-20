<div align="center">

# BabeLLM Gateway

**One OpenAI-compatible endpoint in front of every model you use.**

Self-hosted. Postgres-backed. Routed by policy, logged by default, and managed
from a dashboard instead of a YAML file.

<sub>Next.js 16 · React 19 · Drizzle · Postgres · Docker</sub>

</div>

---

Point any OpenAI client at BabeLLM and it keeps working — the gateway
translates each request into the native SDK of whichever provider actually
serves it, and hands you back a normal OpenAI response.

```ts
const client = new OpenAI({
  baseURL: "https://gw.example.com/v1",
  apiKey: "sk-bab-…",           // a virtual key you minted in the dashboard
});

await client.chat.completions.create({
  model: "smart",                // a virtual model: 3 providers, failover, budgets
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
```

One line changed. Streaming, tool calls, and reasoning all come through.

`/v1/responses` is served alongside it, the same client, the same virtual
model:

```ts
await client.responses.create({
  model: "smart",
  input: "Hello",
  stream: true,
});
```

**What the Responses API supports:**

- Stateful follow-ups (`previous_response_id`, `store`) are forwarded to
  whichever provider serves the request, so they only work reliably when the
  virtual model has **one** target — the id belongs to the provider that
  minted it, and the gateway does not rewrite it to mean "whichever target
  answers next."
- `GET`/`DELETE`/cancel on `/v1/responses/{id}` and `background: true` are not
  supported. A response id is passed through from the provider and carries no
  routing information, so there is nothing to route a retrieval or a
  background poll to.
- Hosted tools (`web_search`, `file_search`, …) need a model whose API flavor
  is `responses`. Against a Chat Completions target the request is **refused
  with a 400**, not silently answered without the tool — and a virtual model
  whose first target can't serve it does not fail over to a later target that
  could.
- Everything else works against any target. What a given target's API can't
  express is dropped rather than rejected, and named in the
  `x-babellm-dropped-params` response header and the request log.

## Why

- **Your keys stay yours.** Provider credentials are encrypted at rest with
  AES-256-GCM and never leave your database. Your apps only ever see virtual
  keys you can revoke, budget, and rate limit one at a time.
- **Swap models without shipping code.** A virtual model is a name plus a list
  of targets. Change the targets in the dashboard and every client follows on
  the next request.
- **Outages become someone else's problem.** Route targets fail over on 429s,
  5xx, and timeouts — including mid-stream, right up to the first chunk.
- **Know what you spent.** Every request is logged with cost, latency, TTFT,
  and the full attempt chain, then rolled up into a dashboard that stays fast
  no matter how big the log table gets.
- **No vendor, no control plane, no telemetry.** It's a Docker image and a
  Postgres URL.

## Quick start

```bash
git clone https://github.com/slzdev/babellm-gateway.git
cd babellm-gateway
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build
```

That's the whole stack — Postgres and the gateway, migrated on boot, no Node
or pnpm required. Open **http://localhost:3000**, log in with the demo password
`babellm`, add a provider, and you have an endpoint.

> [!WARNING]
> The compose overlay ships a checked-in `ENCRYPTION_KEY` and admin password so
> it boots with zero setup. Anyone with this repo can decrypt credentials stored
> under it. Keep it on your machine, and use
> [Deploy](#deploy) for anything real.

Set `GATEWAY_PORT` to publish elsewhere (`GATEWAY_PORT=3100 docker compose …`).

## How it works

```mermaid
flowchart LR
    A["Your app<br/><sub>OpenAI SDK</sub>"] -->|"sk-bab-…"| B["BabeLLM<br/><sub>/v1/chat/completions<br/>/v1/responses</sub>"]
    B --> C{"Virtual model<br/><sub>policy + targets</sub>"}
    C -->|1| D["OpenAI"]
    C -->|2| E["Any OpenAI-compatible<br/><sub>Groq, OpenRouter, vLLM…</sub>"]
    C -->|3| F["Gemini"]
    B -.-> G[("Postgres<br/><sub>logs · usage · config</sub>")]
```

Clients can speak either Chat Completions or Responses. Every OpenAI-shaped
provider is called on one of three APIs, whichever its `api_flavor` says —
Chat Completions, Responses, or Anthropic Messages — set per provider and
overridable per catalog model, so one virtual model can mix a
`chat_completions` target with a `responses` one, or either with an
`anthropic_messages` one. Anything behind the gateway that speaks none of the
three — Gemini's `generateContent` — is translated in both directions, and so
is any request that crosses ingress and provider flavor (a Responses request
served by a Chat Completions target, a Chat Completions request served by an
Anthropic Messages target, and so on).

An `anthropic_messages` model is called on `/v1/messages` — the path is
configurable per provider and per model, like the other flavors'. There is no
client-facing `/v1/messages` endpoint: clients keep speaking Chat Completions
or Responses, and the gateway translates both ways, crossing twice for a
Responses request (Responses → Chat Completions → Messages) by reusing the
same wrapper that already crosses Responses into Chat Completions. What a
request loses in translation is named in `x-babellm-dropped-params`, same as
for the other flavors. `temperature` and `top_p` are the exception — they're
forwarded verbatim rather than dropped, because the gateway can't know which
model generation an upstream serves and dropping them would silently change
sampling for the many Anthropic-compatible clones that still honor them. The
cost is that Anthropic models released after Claude Opus 4.6 reject any
non-default value of either with a 400 — from the endpoint, not the gateway,
as the SDK's own `@deprecated` notes on `temperature` and `top_p` document.

| Provider type | Status |
| --- | --- |
| `openai` | ✅ Chat Completions, Responses, and Anthropic Messages flavors |
| `openai_compatible` | ✅ Groq, OpenRouter, vLLM, LM Studio, anything OpenAI-shaped — Chat Completions, Responses, and Anthropic Messages flavors |
| `gemini` | ✅ Native `@google/genai`, including thinking and media by URL |
| `bedrock` | 🚧 Configurable, not yet served |

## Features

### Routing that earns its keep

A virtual model holds a list of route targets, and two independent columns
decide the order they're tried in.

`priority` groups targets into **tiers**, always walked lowest-number first:
every target in a tier is tried before the next tier is touched. `policy`
orders the targets *inside* a tier:

| Policy | Order inside a tier |
| --- | --- |
| `failover` | Creation time, oldest first. |
| `weighted` | A weighted draw without replacement — the whole tier is weighted, not just its head. |
| `round_robin` | The tier, rotated one position per request. |

So "try my cheap flex capacity first, then spread the fallback across two
providers" is three rows and a `weighted` policy:

| Target | Service tier | Priority | Weight |
| --- | --- | --- | --- |
| `groq/gpt-oss-120b` | `flex` | 0 | 100 |
| `groq/gpt-oss-120b` | — | 1 | 50 |
| `bedrock/openai.gpt-oss-120b` | — | 1 | 50 |

Targets default to priority `0` — a single tier, and the plain policy
behaviour. `max_attempts` caps the flattened chain, so a first tier bigger
than it starves the tiers behind it.

Retryable failures (429, 5xx, timeout, connection error) move to the next
target. Fatal ones (400, 401) stop immediately, because they'd fail the same
way everywhere. When the chain is exhausted the client gets the last real
error, not a blanket 502 — three rate-limited targets read as `429`. Streaming
fails over on the same loop until its first chunk lands.

`x-babellm-provider` and `x-babellm-upstream-model` on the response name who
actually served. Targets can pin a service tier (`flex`, `priority`,
`ultrafast`, …) where the provider supports one.

### A breaker per target

A target that fails retryably — 429, 5xx, timeout, connection error — five
times in a row (configurable; `0` disables the breaker for that scope) opens
for a 30-second cooldown (also configurable, globally or per target). An open
target doesn't drop out of the chain — it sinks behind every closed target,
across every priority tier — so a total outage still gets attempted instead of
turning into a `503`. Client aborts and fatal 4xx never count against a
target.

There's no separate half-open state to track: the open marker's TTL is the
cooldown itself, and the failure counter's TTL is set longer on purpose, so
the counter is still at the threshold when the marker expires. The target
rejoins the chain on the next request, and one more failure re-opens it
immediately — a free probe with no scheduler behind it.

`<provider>/<model>` direct addresses are a single link, not a chain, so
they're never breakered — demoting the only candidate could only turn a
maybe-success into a guaranteed failure.

State lives in Redis when `REDIS_URL` is set, and per process otherwise, so
multiple instances each learn a target is down on their own. In steady state
it costs two Redis commands per request — one `MGET` on the read path, one
fire-and-forget `DEL` on success — and adds no latency. Breaker state and a
manual reset live on each virtual model's page.

Two things worth knowing before production surfaces them: a stream that fails
after its first chunk isn't counted, since success is recorded at the same
first-chunk boundary failover already uses; and a threshold or cooldown
change takes up to 10 seconds to reach other instances, the interval routing
settings are cached for.

### Direct addressing

Skip the virtual model entirely — `<provider>/<model>` reaches anything in the
catalog:

```ts
client.chat.completions.create({ model: "xai/grok-4.5", messages });
```

Names resolve as virtual models first, so `xai/grok-4.5` can also be a virtual
model that shadows the direct route — the supported way to put a policy in
front of a name your clients already send.

### A model catalog that knows the prices

The Catalog page lists every model each provider actually serves, discovered
from the provider itself and enriched field-by-field:

| Layer | Source |
| --- | --- |
| Override | Anything you edit in the dashboard. Always wins, survives every re-sync. |
| Discovered | What the provider reported. |
| Registry | [models.dev](https://models.dev), fetched daily, cached, and toggleable for air-gapped deploys. |
| Seed | A vendored models.dev snapshot, so a first boot with no network still has context windows and prices. |

Syncing is explicit — per provider, or all at once — and a model that stops
being returned is marked *missing* rather than deleted, so a provider having a
bad day can't quietly erase your catalog.

### Usage, cost, and logs

`/dashboard` shows usage, cost, and errors across the gateway: stat tiles with
period-over-period deltas, time series, and breakdowns by model, key, user, and
provider — filterable by range, key, user, or model, with **View these
requests** handing the same filter to `/logs`.

It reads an hourly rollup table rather than the raw log, so it stays fast as
the log grows, and usage history **outlives the log retention window**: a
month's rows can roll off while its totals live on.

Every request is recorded with its key, model, status, latency, TTFT, token
counts, cost, and the full attempt chain with each target's failure reason.
Open any row for the timeline and cost breakdown, or look it up by the
`x-request-id` the gateway returns.

<details>
<summary><b>Payload capture and retention</b></summary>

**Payload capture is off by default**, and enabled per key from the API keys
page. When on, the exact request and response bodies are stored with that key's
logs (the assembled completion for a streamed response), bounded by a
configurable cap — 256 KiB by default — with anything larger stored as a
truncated preview. This writes prompt and completion content to your database;
treat it accordingly.

**Retention is set in whole months** (default 3) and enforced by dropping
monthly partitions outright rather than deleting rows. `0` keeps everything. A
value of `N` keeps the current month and the `N − 1` before it, so the youngest
logs are always retained in full. It is coarse by construction: there is no way
to delete an individual day, or one row's captured content, ahead of its whole
month rolling off.

Partitions for the current month and three ahead are provisioned at boot and
every 24 hours after, under an advisory lock so only one instance does the
work.

</details>

### Tagging requests

Any request may carry an `x-babellm-tags` header of comma-separated
`key=value` pairs. The gateway records them on the request log, and `/logs`
can filter by any combination of them.

```ts
await client.chat.completions.create(
  { model: "smart", messages: [{ role: "user", content: "Hello" }] },
  { headers: { "x-babellm-tags": "env=prod,feature=checkout,customer=acme-3122" } },
);
```

The rules, all enforced:

| Rule | Limit |
| --- | --- |
| Header size | 2048 bytes |
| Number of tags | 16 |
| Key | `[a-z0-9_.-]`, 1–64 characters, lowercased |
| Value | 1–256 characters, no control characters, no `,` |
| Duplicate keys | rejected |

Keys are lowercased, so `Env` and `env` are one dimension. Values keep their
case. A value cannot contain a comma, because the separator is unescaped.

**A header that breaks any of these rules fails the request with a `400`**
rather than being dropped, and the rejection is logged against the calling
key. This is deliberate: a tag that is silently discarded produces a dashboard
quietly missing a slice of its traffic, with nothing on either side to reveal
it. The request is rejected before any provider is called, so it costs nothing
upstream.

Tags are stored on the request log only. They are not forwarded to providers,
they do not appear in the usage and cost dashboard, and they cannot carry
limits or budgets. They age out with the log rows that hold them, at whatever
retention the logging settings specify.

### Rate limits and budgets

Every key can carry an `rpm` limit, a `tpm` limit, a monthly budget, and a
total budget. Over-limit requests are rejected with `429` before they reach a
provider — a key with none configured is never counted and costs nothing.
Served responses carry the usual headers so clients can pace themselves:

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 41
x-ratelimit-reset-requests: 23
```

Limits use a sliding window, and a rate-limit `429` carries `Retry-After`.
Counters live in memory by default; set `REDIS_URL` and every instance shares
one set that survives a restart. **When the counter store is unreachable the
gateway serves the request** — a counter blip must not become a gateway outage.

<details>
<summary><b>Three things limits deliberately don't do</b></summary>

- **Reserve ahead.** Tokens and cost are only known after a request finishes,
  so the check is "was this key already over" and the charge lands afterwards.
  A key can overshoot by whatever was in flight when it crossed.
- **Log rejections.** A rejected request never reached a provider, and one row
  per rejection is the write pattern that grows fastest exactly when the
  gateway is under most stress. Throttling shows up in the Keys page usage
  column.
- **Survive a crash mid-rejection.** A rejection gives back the rpm it counted;
  if the process dies between the two, that key's window reads one too high
  until it expires.

</details>

## Configure

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. **Required.** |
| `ENCRYPTION_KEY` | AES-256-GCM key for provider credentials at rest. 64 hex chars — `openssl rand -hex 32`. **Required.** |
| `ADMIN_PASSWORD` | Shared dashboard password. There is no per-user login. **Required.** |
| `SESSION_SECRET` | Signs the admin session cookie, 32+ chars. **Required.** |
| `REDIS_URL` | Shared rpm/tpm/spend counters. Unset means an in-process map. |

Everything else — providers, virtual models, keys, retention, payload caps — is
configured in the dashboard and stored in Postgres.

> [!IMPORTANT]
> Don't reuse a fresh `ENCRYPTION_KEY` across environments if you already have
> encrypted credentials under another one: rotating it makes those rows
> undecryptable.

## Deploy

The app runs as a plain Docker image with `next start` — no serverless
constraints, no platform lock-in.

```bash
docker build -t babellm-gateway .

docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/babellm \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_PASSWORD=... \
  babellm-gateway
```

The entrypoint migrates the database before serving, so a fresh deploy sets
itself up. To migrate by hand — `drizzle-kit` isn't in the production image:

```bash
DATABASE_URL=... node scripts/migrate.mjs
```

**Health checks.** `GET /health/check` (and `HEAD`) answers `200` with
`{ "status": "ok", "uptime": 1423 }` for as long as the process is serving. No
API key, no session, never cached. It is a *liveness* check by design: failing
it when a shared dependency blips would pull every instance out of rotation at
once. Watch Postgres and Redis through monitoring instead.

## Status

This is a real gateway — the `openai` SDK talks to it end to end, with
streaming, tool calls, and policy-driven routing across every target — built in
phases. What's still missing:

- **The Responses ingress covers less ground than Chat Completions.** No
  retrieval, deletion, or cancellation on `/v1/responses/{id}`, no
  `background: true`, and a stateful follow-up only lands on the right
  provider when the virtual model has one target — see the note under the
  quick-start example above.
- **Spend counters are volatile** without `REDIS_URL` — a restart resets each
  key's total spend to zero.
- **Round-robin state is per process**, so multiple instances skew the
  distribution.
- **No Bedrock adapter, no `/v1/models`, no `/v1/embeddings`.** A `bedrock`
  provider is accepted by the dashboard but returns `501`.
- **Reasoning travels one way.** Reasoning summaries and Gemini thoughts are
  surfaced as `reasoning_content` but never fed back upstream, so long tool
  loops on models that expect their own reasoning items may degrade.

Parameters a provider's API can't express are dropped rather than rejected, and
named in the `x-babellm-dropped-params` response header and the request log —
so a dropped `logprobs` on a Gemini provider is visible, not silent.

## Contributing

Requires Node, pnpm, and Docker.

```bash
pnpm install
docker compose up -d      # Postgres on 5432
pnpm db:migrate
pnpm dev                  # dashboard + gateway on :3000
```

Tests run against a disposable Postgres on 5434 — never the dev database:

```bash
pnpm test:db:up
cp .env.test.example .env.test
pnpm test
```

See [AGENTS.md](AGENTS.md) for conventions, and
[`docs/superpowers/specs/2026-08-11-babellm-gateway-design.md`](docs/superpowers/specs/2026-08-11-babellm-gateway-design.md)
for the full design: data model, request lifecycle, and provider translation
details.
