---
name: work-issue
description: Use when the user points at a GitHub issue in this repo to work on — "/work-issue 3", "work issue #1", "let's tackle issue 3", or a github.com issue URL — including picking up an issue with no number given.
---

# Work a GitHub Issue

Carry one GitHub issue from unread to closed: read it, agree a design with the user, build it, verify it, ship it, confirm the issue is closed.

**Core principle:** the issue closes because the work landed and was verified — never because the steps were followed.

## Quick Reference

| Step | Command / skill | Gate before moving on |
|------|-----------------|-----------------------|
| 1. Read | `gh issue view N --json ...` | User has seen your summary |
| 2. Brainstorm | `superpowers:brainstorming` | User approved the design |
| 3. Record | `gh issue comment N` | Design is on the thread |
| 4. Implement | `AGENTS.md` workflow | — |
| 5. Verify | `superpowers:verification-before-completion` | Commands actually ran, output seen |
| 6. Integrate | `superpowers:finishing-a-development-branch` | Work merged or PR open |
| 7. Confirm | `gh issue view N --json state` | State is `CLOSED` |

## 1. Read the issue

Resolve the argument to a number: `3`, `#3`, and `https://github.com/.../issues/3` all mean `3`. With no argument, run `gh issue list` and ask which one.

```bash
gh issue view N --json number,title,body,state,labels,comments,url
```

- **Already `CLOSED`?** Stop. Ask whether to reopen it or pick another issue. Do not start work on a closed issue.
- **Read the comments, not just the body.** Issues in this repo carry design discussion; the body alone is often out of date.

Summarize back to the user: what the issue asks for, what the thread has already decided, and anything it leaves open.

## 2. Brainstorm with the user

Invoke `superpowers:brainstorming` with the issue as the idea. That skill classifies the work (spike / bounded / architectural) and runs its own approval gate — do not pre-judge the classification or skip ahead of it.

If the issue is too vague to design against, ask the question **on the issue thread** (`gh issue comment N`) rather than guessing at an answer. Say so, and stop until it is answered.

## 3. Record the agreed design

Once the user approves the design, put it on the issue before writing code:

```bash
gh issue comment N --body "$(cat <<'EOF'
## Agreed approach
...
EOF
)"
```

The thread should explain the plan to someone who wasn't in the conversation.

## 4. Implement

Follow the implementation workflow in `AGENTS.md` exactly: ask execution mode, then git isolation, **one question at a time, waiting for each answer**. Default branch name: `issue-N-<short-slug>`.

Everything in `AGENTS.md` still applies — read `node_modules/next/dist/docs/` before writing Next.js code, build UI from `src/components/ui/` shadcn primitives.

## 5. Verify

Invoke `superpowers:verification-before-completion`, and run what this repo actually defines:

```bash
pnpm lint && pnpm test && pnpm build
```

Read the output. Failing or skipped checks get reported as failing or skipped — never summarized as passing.

## 6. Integrate

Ask the `AGENTS.md` integration question (merge / branch / branch + PR), then follow `superpowers:finishing-a-development-branch`.

The PR body — or the merge commit, if merging straight to main — **must** contain:

```
Closes #N
```

## 7. Confirm it closed

```bash
gh issue view N --json state,url
```

- `CLOSED` → report the issue number, what shipped, and the URL.
- Still `OPEN` after the work landed → `gh issue close N --comment "Shipped in <sha>: <summary>"`.
- Work not landed → the issue stays open. Say where things stand.

## Red Flags — STOP

- About to `gh issue close` while the branch is unmerged or a check is failing
- About to write code before the user approved a design in step 2
- About to say "issue closed" without having seen `"state":"CLOSED"` in command output
- Skipping the brainstorm because the issue "is obviously a one-liner"
- Asking the `AGENTS.md` questions all at once instead of one at a time

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Designing from the issue body alone | Read the comment thread; it usually holds the real decision |
| Inventing an answer to an ambiguous requirement | Ask on the issue thread and wait |
| Assuming `Closes #N` worked | Check `state` explicitly in step 7 |
| Closing the issue to "tidy up" while work is in review | An open PR means an open issue |
