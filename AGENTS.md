<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# UI: prefer shadcn/ui

This project uses shadcn/ui (see `components.json` — `base-nova` style, `neutral` base color, `lucide` icons). **Build UI out of shadcn components wherever possible.**

- Check `src/components/ui/` first — it already holds `alert-dialog`, `badge`, `button`, `card`, `chart`, `collapsible`, `combobox`, `dialog`, `dropdown-menu`, `input`, `input-group`, `label`, `select`, `sonner`, `switch`, `table`, `tabs`, `textarea`.
- If a shadcn component exists for what you need but isn't installed yet, add it with `pnpm dlx shadcn@latest add <component>` rather than hand-rolling it.
- Compose and extend the shadcn primitives (variants, `cn()`, wrapper components) instead of writing bespoke markup that duplicates them.
- Only write a custom component when shadcn genuinely has no equivalent — and say so when you do.

# Never run tests or browser checks against the development database

`docker compose up -d` starts Postgres on **5432 with a persistent volume**. That is the developer's own database — their providers, API keys, and settings live in it, and nothing automated may touch it. `resetDb()` in `tests/helpers/db.ts` TRUNCATEs every table it knows about, and a browser check drives the real dashboard; either one aimed at 5432 destroys work that cannot be recovered.

Use the disposable Postgres on **5434** instead. `docker-compose.test.yml` defines it: tmpfs-backed, no volume, gone when the container stops.

```bash
pnpm test:db:up      # start it (waits until it accepts connections)
pnpm test:db:down    # stop it and throw the data away
```

**`test:db:down` reaches every worktree, not just yours.** The compose project is shared, so a down/up destroys the test containers for all checkouts at once — including a sibling worktree with a suite in flight, which then fails in a way that looks like its own bug and cannot be reproduced. Only ever run it when you know nothing else is testing. When all you need is a clean *database*, drop and recreate your own on the running server: `tests/setup/global-setup.ts` rebuilds it on the next run. Note also that a `down` only stops services defined in *your* checkout's `docker-compose.test.yml`, so a service another branch added survives as an orphan and the "full reset" is not full.

- **Tests** read `.env.test`, which is gitignored. In a fresh checkout or worktree create it with `cp .env.test.example .env.test` — never hand-write it, and never repoint its `DATABASE_URL` at 5432. Then `pnpm test`.
- **In a worktree, give the database its own name** — edit only the database at the end of `DATABASE_URL`, e.g. `babellm_test_<feature>`, keeping host and port on 5434. Worktrees otherwise share one `babellm_test`, which breaks two ways: drizzle decides what is pending from journal timestamps, so a sibling branch's same-numbered migration makes yours look already-applied and its DDL never runs (`column ... does not exist` on a brand-new container); and `tests/lib/catalog/sync.test.ts` counts advisory locks database-wide, so a concurrent run turns `expected 1` into `expected 7` — failures that read as real regressions in untouched code.
- **Browser checks** use `pnpm dev:test-db`, which migrates a separate `babellm_dev` database on 5434 and serves the dashboard on **port 3001**. Never use `pnpm dev` for a browser check: it reads `.env` and drives the dashboard against 5432. The dedicated port and `distDir` are what let it run while the developer's own `pnpm dev` still holds 3000 — do not stop their server.

This supersedes the older arrangement where `.env.test` named a `babellm_test` database on 5432. Any note still claiming `docker compose up -d` is enough to run the suite is stale.

# Implementation workflow

Before starting **non-trivial** implementation work, ask the user how to run it. Non-trivial means multi-step or multi-file changes. Skip these questions for one-line fixes, typo/doc tweaks, and read-only investigation — just do those inline on the current branch.

Ask with `AskUserQuestion`, **one question at a time, in this order**. Wait for each answer before asking the next.

## 0. Specs and plans never land on `main` directly

Design docs under `docs/superpowers/specs/` and `docs/superpowers/plans/` belong to the work they describe. Commit them on the worktree/branch that implements them and let them reach `main` only through that merge — never commit a spec or plan straight to `main`. A design that ends up never being built should disappear with its branch instead of leaving a stale doc, and a cleanup commit, in the history.

In practice this means the git-isolation question comes **before** the spec is written, not after: as soon as brainstorming looks like it will produce a spec or plan, ask question 2 below, create the worktree/branch, then write the doc there.

This overrides the "skip these questions for doc tweaks" rule above — specs and plans are never treated as trivial doc edits. Docs that describe what already exists (`README.md`, `AGENTS.md`, notes on shipped code) are ordinary changes and follow the normal rules.

## 1. Execution mode

> How should this be executed?

- **Subagent-driven** — dispatch subagents per task (`superpowers:subagent-driven-development`, `superpowers:dispatching-parallel-agents`)
- **Inline** — implement directly in this session

## 2. Git isolation

> Where should the work happen?

- **Git worktree** — isolated workspace (`superpowers:using-git-worktrees`)
- **Git branch** — new branch in the current workspace
- **On main** — no isolation

## 3. When the work is finished

Once the implementation is complete and verified (`superpowers:verification-before-completion`), ask:

> How should this be integrated?

- **Merge into main**
- **Create a branch**
- **Create a branch + PR**

Then follow `superpowers:finishing-a-development-branch`.

**Merging a worktree into `main` is always a squash merge** — `git merge --squash <branch>` followed by a single commit that describes the whole change, never a merge commit or a replay of the branch's intermediate commits. Worktree branches accumulate WIP, fixup, and review-feedback commits that mean nothing once the work has landed; `main` should carry one commit per unit of work. Delete the branch and remove the worktree afterwards.

## Defaults

If the user does not answer, or the session is non-interactive: **subagent-driven execution in a git worktree**, and create a branch + PR when finished.
