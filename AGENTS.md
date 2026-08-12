<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Implementation workflow

Before starting **non-trivial** implementation work, ask the user how to run it. Non-trivial means multi-step or multi-file changes. Skip these questions for one-line fixes, typo/doc tweaks, and read-only investigation — just do those inline on the current branch.

Ask with `AskUserQuestion`, **one question at a time, in this order**. Wait for each answer before asking the next.

## 1. Execution mode

> How should this be executed?

- **Subagent-driven** — dispatch subagents per task (`superpowers:subagent-driven-development`, `superpowers:dispatching-parallel-agents`)
- **Inline** — implement directly in this session

## 2. Git isolation

> Where should the work happen?

- **Git worktree** — isolated workspace (`superpowers:using-git-worktrees`)
- **Git branch** — new branch in the current workspace
- **On master** — no isolation

## 3. When the work is finished

Once the implementation is complete and verified (`superpowers:verification-before-completion`), ask:

> How should this be integrated?

- **Merge into master**
- **Create a branch**
- **Create a branch + PR**

Then follow `superpowers:finishing-a-development-branch`.

## Defaults

If the user does not answer, or the session is non-interactive: **subagent-driven execution in a git worktree**, and still ask the integration question at the end rather than merging or pushing on your own.
