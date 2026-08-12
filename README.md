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

This is **Phase 1** of a four-phase build. It is a real gateway — the
`openai` SDK talks to it end to end, including streaming and tool calls —
but only a slice of the design is implemented. See
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

Syncing is explicit: a **Sync models** button per provider, **Sync all** on the
catalog page, and an automatic sync whenever you edit a provider (any field,
not just credentials — saving a provider always re-syncs it). Nothing runs on
a timer.

The catalog is advisory. Route targets remain free text — the picker suggests
models and warns about names it does not recognise, but never blocks a save, and
the gateway request path never reads the catalog. A model that stops being
returned is marked *missing* rather than deleted, so a provider having a bad day
cannot quietly erase your catalog or the overrides on it.

`openai_compatible` providers can set a **registry namespace** (`groq`,
`openrouter`, …) so their models match models.dev entries. A self-hosted or
unlisted `openai_compatible` endpoint has no models.dev namespace, so those
models stay unenriched unless you override them by hand.

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

Phase 1 covers the schema, admin auth, provider/virtual-model/key CRUD, the
`openai` and `openai_compatible` adapters, and `/v1/chat/completions` with
streaming and tool calling against a single route target per virtual model.
Everything below is **recorded but not yet acted on**, or not built at all:

- **Rate limits and spend budgets are enforced nowhere.** A key's
  `rpm_limit`, `tpm_limit`, `budget_monthly_usd`, and `budget_total_usd` can
  be set in the dashboard and are stored, but no request is ever rejected
  because of them. **A configured budget is not a spend cap** until Phase 4
  ships budget enforcement — do not treat it as one.
- **Only the first route target is used.** Failover, weighted routing,
  round robin, and the circuit breaker (Phase 2) do not exist yet; a
  virtual model with multiple targets ignores all but the highest-priority
  one.
- **No request logging or log viewer** (Phase 2). Debugging a failed
  request today means reading server logs, correlated by `x-request-id`.
- **No Gemini or Bedrock adapters, no `/v1/models`, no `/v1/embeddings`**
  (Phase 3). Configuring a `gemini` or `bedrock` provider is accepted by
  the dashboard but every request to it returns `501 unsupported_operation`.
- **No cost computation, price table, opt-in payload logging, or retention
  pruning** (Phase 4). `cost_usd` is always null.

## Learn more

The full design — data model, request lifecycle, provider translation
details, and the phase breakdown — is in
[`docs/superpowers/specs/2026-08-11-babellm-gateway-design.md`](docs/superpowers/specs/2026-08-11-babellm-gateway-design.md).
