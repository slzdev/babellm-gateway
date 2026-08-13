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

A request does not have to go through a virtual model. `<provider>:<model>`
reaches any model on the **Catalog** page directly:

```ts
client.chat.completions.create({ model: "xai:grok-4.5", messages })
```

The prefix is the provider's name as it appears on the Providers page, and
everything after the **first** colon is the model id — so a fine-tune keeps its
own colons (`openai:ft:gpt-4o:acme::abc123`).

The name is looked up as a virtual model first, and only falls through to a
direct address when nothing matches. Naming a virtual model `xai:grok-4.5`
therefore shadows the direct route rather than being unreachable behind it,
which is the supported way to put a policy in front of a name your clients
already send.

A direct address is one target and one attempt: there is no failover, because
there is nothing to fail over to. Model ids are checked against the catalog, so
a typo comes back as `404 model_not_found` without a round trip to the
provider — sync a provider before addressing its models directly. A model whose
catalog row is marked *missing* still routes; a disabled provider answers
`503 no_targets_available`.

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
the model catalog, the `openai` and `openai_compatible` adapters, and
`/v1/chat/completions` with streaming, tool calling, and policy-driven routing
across every route target. Everything below is **recorded but not yet acted
on**, or not built at all:

- **Rate limits and spend budgets are enforced nowhere.** A key's
  `rpm_limit`, `tpm_limit`, `budget_monthly_usd`, and `budget_total_usd` can
  be set in the dashboard and are stored, but no request is ever rejected
  because of them. **A configured budget is not a spend cap** until Phase 4
  ships budget enforcement — do not treat it as one.
- **No circuit breaker.** Routing tries every policy's chain on every
  request, so a provider that is down costs one wasted attempt each time
  rather than being taken out of rotation. See [Routing](#routing).
- **No stored request history and no log viewer.** Each request emits one
  JSON line on stdout; nothing is written to the database. Debugging a past
  request means searching your container logs by `x-request-id`.
- **No Gemini or Bedrock adapters, no `/v1/models`, no `/v1/embeddings`**
  (Phase 3). Configuring a `gemini` or `bedrock` provider is accepted by
  the dashboard but every request to it returns `501 unsupported_operation`.
- **No cost computation, price table, opt-in payload logging, or retention
  pruning** (Phase 4). `cost_usd` is always null.

## Learn more

The full design — data model, request lifecycle, provider translation
details, and the phase breakdown — is in
[`docs/superpowers/specs/2026-08-11-babellm-gateway-design.md`](docs/superpowers/specs/2026-08-11-babellm-gateway-design.md).
