# BabeLLM Gateway

A self-hosted LLM gateway. It exposes an OpenAI-compatible HTTP API and
translates each request to the native SDK of whichever provider actually
serves it. Admins manage providers, virtual models, and virtual API keys from
a web dashboard.

Any OpenAI client works by changing one line:

```ts
new OpenAI({ baseURL: "https://gw.example.com/v1", apiKey: "sk-bab-…" })
```

## Status

This is **Phase 2** of a four-phase build. It is a real gateway — the
`openai` SDK talks to it end to end, including streaming and tool calls, and
a virtual model's targets are routed by policy with failover — but only a
slice of the design is implemented. See
[Not yet implemented](#not-yet-implemented) before relying on it for
anything with real spend behind it.

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `ENCRYPTION_KEY` | AES-256-GCM key for provider credentials at rest. 64 hex characters (32 bytes). Generate with `openssl rand -hex 32`. |
| `ADMIN_PASSWORD` | Single shared password for the dashboard. There is no per-user login. |
| `SESSION_SECRET` | Signs the admin session cookie. At least 32 characters. Generate with `openssl rand -hex 32`. |

Copy `.env.example` to `.env` and fill these in for local development.

## Local development

1. Start Postgres:

   ```bash
   docker compose up -d
   ```

   This starts Postgres only, leaving port 3000 to the dev server below. To
   run the gateway in a container too, see
   [Run the whole stack](#run-the-whole-stack).

2. Install dependencies and apply migrations:

   ```bash
   pnpm install
   pnpm db:migrate
   ```

3. Run the dev server:

   ```bash
   pnpm dev
   ```

   The dashboard is at `http://localhost:3000` (redirects to `/login`), and
   the gateway is at `http://localhost:3000/v1/*`.

Tests run against a disposable database, driven by `.env.test`:

```bash
pnpm test
```

## Run the whole stack

To get a complete working server — Postgres *and* the gateway — without
installing Node or pnpm, add the `docker-compose.gateway.yml` overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build
```

The dashboard is at `http://localhost:3000` and the gateway at
`http://localhost:3000/v1/*`. The container migrates the database on boot, so
there is no separate setup step. Set `GATEWAY_PORT` to publish somewhere else
(`GATEWAY_PORT=3100 docker compose …`) — useful when `pnpm dev` already holds
port 3000.

To drop the flags from every subsequent command:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.gateway.yml
docker compose up -d --build
docker compose logs -f gateway
docker compose down
```

**The credentials in that overlay are public.** It ships a checked-in
`ENCRYPTION_KEY` and the admin password `babellm` so the stack boots with no
setup — which means anyone with this repo can decrypt the provider credentials
it stores, and anyone who can reach the port owns the dashboard. Keep it on
your own machine. To use real values, put them in `.env` (start from
`.env.example`); Compose loads that file automatically and it overrides the
defaults. `DATABASE_URL` is the exception — the overlay always points it at the
`postgres` service, since a host-local URL does not resolve inside the
container.

For anything beyond a local trial, use the deployment path in
[Production deployment](#production-deployment) instead.

## Model catalog

The **Catalog** page lists every model each provider actually serves. It is
populated by asking providers directly — `GET /v1/models` for `openai` and
`openai_compatible` — and enriched from three further layers, resolved field by
field with the first non-null value winning:

| Layer | Source |
|---|---|
| Override | Anything you edit in the dashboard. Always wins, and survives every re-sync. |
| Discovered | What the provider reported. OpenAI-shaped endpoints report only a model id. |
| Registry | [models.dev](https://models.dev), fetched at most daily and cached in the database. Toggleable, for deployments without egress. |
| Seed | A models.dev snapshot vendored into the repo, so a first boot with no network still has context windows and prices. Refresh with `pnpm seed:refresh`. |

Syncing is explicit: a **Sync models** action in each provider's row menu, a
**Sync all** button on the catalog page, and an automatic sync whenever you
edit a provider (any field, not just credentials — saving a provider always
re-syncs it). Nothing runs on a timer.

The catalog is advisory for virtual models: route targets remain free text — the
picker suggests models and warns about names it does not recognise, but never
blocks a save, and routing through a virtual model never reads the catalog. It
is authoritative for [direct addressing](#direct-addressing), which can only
reach a model the catalog lists. A model that stops being returned is marked
*missing* rather than deleted, so a provider having a bad day cannot quietly
erase your catalog or the overrides on it — nor take a directly addressed model
off the air.

`openai_compatible` providers can set a **registry namespace** (`groq`,
`openrouter`, …) so their models match models.dev entries. A self-hosted or
unlisted `openai_compatible` endpoint has no models.dev namespace, so those
models stay unenriched unless you override them by hand.

## Governance

### Request logs

Every request the gateway serves is recorded: the caller's key name, the
model asked for, status and outcome, latency and time-to-first-token, the
full attempt chain with each target's failure reason, token counts, and
cost. Browse them at `/logs` — filter by time range, key, model, and status,
or jump straight to one by its request id — and open any row for a detail
page with the full attempt timeline and cost breakdown.

### Choosing a store

Settings › Governance picks where request logs go: `postgres` (default,
readable — this is what powers `/logs`) or `stdout` (write-only, one JSON
line per request). A change takes effect on the instance that made it
immediately, and on every other instance within 15 seconds — the resolved
store is cached for that long so it isn't re-read on every request.
Switching does not migrate existing logs: the previous store keeps its rows,
and switching back brings them into view again. On `stdout`, `/logs` shows
an empty state and debugging a past request goes back to searching container
logs by the `x-request-id` header the gateway returns.

The default store writes to the gateway's own database, which is right for
development and low traffic; at high request rates the table and its three
indexes compete with the queries that serve requests.

### Upgrading from an earlier version

`postgres` is the default store, so a gateway upgraded from a version that
predates this feature starts writing request logs into its own database as
soon as it boots on the new code. Selecting `stdout` on the Settings page
restores exactly the previous behavior. The stdout line itself gained token
and cost keys — additively, so existing parsers keep working.

### Payload capture

Off by default. Turn it on per key on the **API keys** page: the create-key
dialog has a switch, and an existing key's row menu has a "Turn on/off
payload logging" action, with a **Payloads** column showing which keys
currently capture. When on, the gateway stores the exact request and
response bodies with that key's logs (the assembled completion for a
streamed response), bounded by the payload cap in Settings › Governance
(256 KiB by default) — anything larger is stored as a truncated preview.
This writes prompt and completion content to the database, so treat it the
way you'd treat any other place that content ends up.

### Retention

Request logs are pruned hourly, governed by the retention-days setting in
Settings › Governance; `0` disables pruning. Exactly one instance prunes at
a time.

## Routing

A virtual model holds a list of route targets and the gateway uses all of
them. `policy` decides the order it tries them in:

| Policy | Order |
|---|---|
| `failover` | Priority order — lowest `priority` first, ties broken by creation time. |
| `weighted` | A weighted draw without replacement, so the whole chain is weighted rather than just its head. A target with weight `0` or less sorts last; it is never dropped. |
| `round_robin` | The same list, rotated one position per request. |

`max_attempts` bounds the chain. The gateway tries at most
`min(max_attempts, number of eligible targets)` of them and never tries the
same target twice.

A **retryable** failure moves to the next target: a 429, a 5xx, a timeout, a
connection error. A **fatal** one stops immediately and the client sees it —
a 400 or a 401 would fail the same way at every provider, so spending the
rest of the chain on it only delays the answer. When the chain is exhausted
the client gets the last provider's actual error rather than a blanket 502,
so three rate-limited targets read as `429`. A target whose provider type has
no adapter yet (`gemini`, `bedrock`) is skipped and the chain continues.

Streaming requests fail over on the same loop, up to their first chunk: the
response is not committed until that chunk is in hand. After it the response
is locked to the target that produced it, and a later upstream failure ends
the stream with an SSE `error` event rather than moving on.

`x-babellm-provider` and `x-babellm-upstream-model` on the response name the
target that actually served — which under failover is not the first one tried.

### Direct addressing

A request does not have to go through a virtual model. `<provider>/<model>`
reaches any model on the **Catalog** page directly:

```ts
client.chat.completions.create({ model: "xai/grok-4.5", messages })
```

The prefix is the provider's name as it appears on the Providers page, and
everything after the **first** slash is the model id — so a namespaced model id
keeps its own slashes (`together/meta-llama/Llama-3-70b`).

The name is looked up as a virtual model first, and only falls through to a
direct address when nothing matches. Naming a virtual model `xai/grok-4.5`
therefore shadows the direct route rather than being unreachable behind it,
which is the supported way to put a policy in front of a name your clients
already send.

A direct address is one target and one attempt: there is no failover, because
there is nothing to fail over to. Model ids are checked against the catalog, so
a typo comes back as `404 model_not_found` without a round trip to the
provider — sync a provider before addressing its models directly. A model whose
catalog row is marked *missing* still routes; a disabled provider answers
`503 no_targets_available`.

### API flavor

Some OpenAI-compatible providers serve `/v1/responses` but not
`/v1/chat/completions`. Each `openai` or `openai_compatible` provider therefore
carries an **API flavor** — `Chat Completions` (the default) or `Responses` —
set on the Providers page. The gateway's own endpoint does not change: clients
always call `/v1/chat/completions`, and a Responses-flavored provider is
translated in both directions. A single virtual model can mix the two, and
failover crosses between them freely.

A few things to know before pointing production traffic at a Responses
provider:

- **`n` and `stop` are silently ineffective.** The Responses API cannot
  express them, and the gateway drops unmappable parameters rather than
  rejecting requests that would otherwise work. Asking for `n: 3` returns one
  choice, and `stop` sequences do not apply. A dropped parameter that changes
  the answer is named in the `x-babellm-dropped-params` response header and in
  the request log line — `logit_bias`, `logprobs`, `top_logprobs`,
  `frequency_penalty`, `presence_penalty` and `seed` are dropped the same way,
  as is an `input_audio` content part (reported as `audio_content`). Sending
  `n: 1`, `frequency_penalty: 0`, `presence_penalty: 0`, `stop: []`,
  `logprobs: false`, or `logit_bias: {}` is **not** reported — those values
  already match what the Responses API does on its own, and reporting them
  would put a line in the header on nearly every request and bury the cases
  that actually change the answer. An absent header therefore means "nothing
  that would change the answer was dropped," not "nothing was dropped."
- **The deprecated functions API is not structurally supported.** A
  `role: 'function'` message carries only a `name` and no call id, so it
  cannot become a `function_call_output` the way a `role: 'tool'` message can.
  The gateway instead carries the result through as a `user` message reading
  `[function result: <name>] <content>` — `user`, not `developer`, because the
  content is third-party data and `developer` is a high-authority instruction
  channel — and reports `legacy_function_message` in the dropped-params
  header. Use `tools` and `tool_call_id` instead.
- **A `tool` message without a `tool_call_id` is carried the same way.**
  `tool_call_id` is optional in the request schema, so a valid request can
  omit it; emitting a `function_call_output` with a fabricated `call_id`
  would send a dangling reference upstream, so the result is carried as a
  `user` message reading `[tool result] <content>` instead, and reports
  `tool_message_without_call_id` in the dropped-params header.
- **Reasoning travels one way.** Reasoning summaries are surfaced as
  `message.reasoning_content` (and `delta.reasoning_content` when streaming) —
  a de-facto convention rather than part of the OpenAI API — but are never fed
  back upstream. Requests are stateless: `store` is always `false` and
  `previous_response_id` is never sent. On models that expect their own
  reasoning item before a function call, long tool loops may degrade.

Summaries are requested only when the client sends `reasoning_effort`, because
asking a non-reasoning model for them is an error. To request them regardless,
set `requestReasoningSummary: true` in the provider's config.

A provider on the wrong flavor fails fast in either direction: a `404` from the
upstream, whichever flavor is misconfigured, comes back with the error naming
the setting to change.

Each settled request writes one JSON line to stdout: request id, key name,
virtual model, status, outcome, latency, time-to-first-token for streams, and
every attempt with its provider, upstream model, status and error. **That line
is the only record.** There is no request history in the database and no log
viewer; once the line scrolls out of your container log the request is
unrecoverable.

Two limitations worth planning around:

- **There is no circuit breaker.** A provider that is hard down is re-attempted
  on every request, so each request pays one wasted upstream call and its
  timeout before failing over. Failover works; it is just not free.
- **Round-robin state is per process.** The cursor lives in memory, so running
  more than one instance skews the distribution — each process starts at zero
  and they all favour the same target — and a restart resets it.

### Endpoint paths

An `openai` or `openai_compatible` provider asks its upstream for three
endpoints, and by default appends the paths the OpenAI SDK uses to the
provider's base URL:

| Endpoint | Default path | Used for |
| --- | --- | --- |
| Models | `/models` | catalog sync |
| Chat completions | `/chat/completions` | requests, when the API flavor is Chat Completions |
| Responses | `/responses` | requests, when the API flavor is Responses |

A clone that hangs the OpenAI shape off somewhere else can override any of the
three under **Advanced** on the Providers page. An override is **joined onto the
base URL**, not substituted for it — the base URL keeps carrying whatever prefix
it carries today, so a provider based at `https://api.example/v1` with a models
path of `/api/v2/models` is asked for `https://api.example/v1/api/v2/models`. A
blank field means the default, which is also how you go back to one.

Paths are stored per provider and normalised on save: a missing leading slash is
added and a trailing one removed. A full URL is rejected rather than saved,
because it would be appended rather than replacing the base URL; so is a query
string, which the SDK sends separately from the path.

## Production deployment

The app runs as a Docker image with `next start` — no serverless
constraints, and it is not built with Next's `standalone` output (the
migration entrypoint below lives outside Next's build graph, so a
standalone bundle would not trace its dependencies).

Build the image:

```bash
docker build -t babellm-gateway .
```

Run it against a Postgres instance, with the four required env vars set:

```bash
docker run -d \
  -e DATABASE_URL=postgres://user:pass@host:5432/babellm \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e ADMIN_PASSWORD=... \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -p 3000:3000 \
  babellm-gateway
```

**Do not reuse a generated `ENCRYPTION_KEY` between environments if you
already have encrypted provider credentials under a different key** —
rotating it makes existing rows undecryptable.

### Migrations

The container's entrypoint runs migrations before starting the server, so a
fresh deploy migrates itself. To run migrations by hand (e.g. against a
staging database, without starting the app) — `drizzle-kit` is a
devDependency and is not present in the production image, so this uses a
plain script instead:

```bash
DATABASE_URL=... node scripts/migrate.mjs
```

or, from a full checkout with devDependencies installed, the drizzle-kit
equivalents used in development: `pnpm db:generate` (create a migration from
schema changes) and `pnpm db:migrate` (apply pending migrations).

## Not yet implemented

Phases 1 and 2 cover the schema, admin auth, provider/virtual-model/key CRUD,
the model catalog, the `openai` and `openai_compatible` adapters in both API
flavors, and `/v1/chat/completions` with streaming, tool calling, and
policy-driven routing across every route target. Everything below is
**recorded but not yet acted on**, or not built at all:

- **No `/v1/responses` endpoint.** Responses-flavored *providers* are
  supported; a Responses-shaped *client* is not. Everything enters through
  `/v1/chat/completions`.
- **Rate limits and spend budgets are enforced nowhere.** A key's
  `rpm_limit`, `tpm_limit`, `budget_monthly_usd`, and `budget_total_usd` can
  be set in the dashboard and are stored, but no request is ever rejected
  because of them. **A configured budget is not a spend cap** until Phase 4
  ships budget enforcement — do not treat it as one.
- **No circuit breaker.** Routing tries every policy's chain on every
  request, so a provider that is down costs one wasted attempt each time
  rather than being taken out of rotation. See [Routing](#routing).
- **No Gemini or Bedrock adapters, no `/v1/models`, no `/v1/embeddings`**
  (Phase 3). Configuring a `gemini` or `bedrock` provider is accepted by
  the dashboard but every request to it returns `501 unsupported_operation`.

## Learn more

The full design — data model, request lifecycle, provider translation
details, and the phase breakdown — is in
[`docs/superpowers/specs/2026-08-11-babellm-gateway-design.md`](docs/superpowers/specs/2026-08-11-babellm-gateway-design.md).
