# Admin UI: tables and modal forms

Presentation-only rework of the five admin pages. No server actions, `lib/`
code, schema, or gateway behaviour changes.

## Problem

The dashboard works but reads as scaffolding:

- All five pages hand-roll `<table>` markup with ad-hoc classes, while the
  shadcn `Table` primitives sit unused in `src/components/ui/table.tsx`.
- Create forms are always-visible cards pinned below each table, so the page
  ends in a wall of inputs whether or not you are creating anything.
- Edit forms are `<details>`/`<summary>` disclosures nested inside table
  cells. Expanding one reflows the row and pushes the table apart.
- `src/components/ui/dialog.tsx` exists and is used nowhere.
- Feedback is split: buttons toast, forms print inline `<p>` elements.

## Decisions

| Question | Decision |
|---|---|
| Scope of "better table" | Visual polish only. No sorting, filtering, or pagination. |
| Which forms become modals | Every entity create and edit form. Page-level config stays inline. |
| Modal on success | Close the dialog and toast. Errors keep it open with the message inline. |
| The API key reveal | Two-step dialog — form, then a reveal panel. Never auto-closes. |
| Row actions | Collapse into a trailing `⋯` menu. |

## Building blocks

Three new shared pieces:

| File | Purpose |
|---|---|
| `src/components/ui/dropdown-menu.tsx` | From `shadcn add dropdown-menu`. The `base-nova` style resolves to base-ui's `menu`, the same family as the installed Dialog. |
| `src/components/ui/alert-dialog.tsx` | From `shadcn add alert-dialog`. Destructive confirmations. |
| `src/components/admin/form-dialog.tsx` | Owns dialog open state, `useActionState`, and the success/error lifecycle. |

Plus `src/components/admin/page-header.tsx` — title, optional description, and
a trailing action slot — so all five page headers match.

There is deliberately **no** generic `<DataTable>` abstraction. The five tables
have genuinely different cells; the `Table` primitives already deliver
consistency without a configuration layer to work around.

## The FormDialog contract

```tsx
<FormDialog
  trigger={<Button>Add provider</Button>}   // or a DropdownMenuItem
  title="Add a provider"
  action={createProviderAction}             // (prev, formData) => ActionState
  submitLabel="Add provider"
>
  {/* fields — any React tree, owning its own local state */}
</FormDialog>
```

The lifecycle reads the `{ error, success, warning }` shape every action in the
codebase already returns:

- **`error`** — the dialog stays open and renders the message as an inline
  alert above the submit row. Nothing typed is lost.
- **`success`** — `toast.success(state.success)`, then the dialog closes.
- **`success` with `warning`** — closes and fires both toasts. This is the
  provider case where the save landed but the re-sync failed; today it is an
  amber paragraph that is easy to miss.

Two mechanics to get right:

**Stale values on reopen.** Base UI unmounts portal content on close, so each
open remounts a fresh uncontrolled form. On error the dialog never closes, so
values survive. Both behaviours should fall out for free — confirm against the
base-ui dialog docs rather than assuming.

**A menu item opening a dialog.** The menu closes on item click, which races
the dialog opening. The row component owns the dialog's `open` state and the
menu item only sets it; the dialog is a sibling of the menu, never a child.

## Destructive actions

`Delete` is currently a one-click submit with no confirmation. That is
survivable as a visible button, but behind a `⋯` menu it becomes a mis-click
waiting to happen — the menu change causes the risk, so the fix belongs here.

A `ConfirmAction` wrapper (AlertDialog plus the existing server action, toast on
result) covers provider, API key, user, virtual model, and catalog model
deletes. Provider delete names the provider and its route target count.

## Per-page changes

**Providers.** Eight columns to seven — Name, Adapter, Credentials, Targets,
Models, Status, and a trailing actions cell. `Test connection` loses its
dedicated column and becomes a menu item opening a one-field dialog, since the
action requires an `upstreamModel`. Menu: Edit, Sync models, Test connection,
Enable/Disable, Delete. Create and edit are both `FormDialog`s over the same
field set.

**Catalog.** The `<details>` inside the model-id cell splits into two menu
items: *Edit overrides* (the numeric grid and its Clear buttons) and *Route to
a virtual model*. `Add model` moves to the page header. The filter bar and the
Model registry panel stay exactly where they are — they are page-level, not row
entities.

**Virtual models.** Keeps the section-per-model card layout; the nested targets
table adopts the same `Table` primitives. `Add target` becomes a dialog per
section, since its combobox is cramped inline. `Edit target` moves from
`<details>` to a dialog. `Create model` moves to the header.

**API keys.** Create becomes the two-step dialog: form, then a reveal panel
holding the key, a Copy button, and Done. Revoke/Restore and Delete collapse
into the `⋯` menu.

The reveal step must **block every dismissal route**, not merely decline to
auto-close. The key is already persisted server-side by the time it is shown,
and it is unrecoverable, so Escape, a backdrop click, and the dialog's own X
button all have to be gated while the reveal is up — leaving **Done** as the
only exit. Declining to auto-close on success only defends against a threat
this flow never had; reflex dismissal is the real one.

**Users.** Header button plus create dialog, `⋯` menu for Delete.

## Out of scope

Server actions, `lib/` code, database schema, and the gateway request path are
untouched. Every action keeps its current signature and return shape — that is
what lets the `FormDialog` contract exist without backend changes.

## Verification

There is no component-test harness: `tests/` is entirely lib-level and
testing-library is not installed. This change is therefore verified by

- `pnpm lint`
- `pnpm build` (typecheck)
- `pnpm test` staying green, which it should, since no `lib/` code moves
- walking each of the five pages in a browser

Standing up a jsdom and testing-library harness is a reasonable follow-up, but
it is its own piece of work and should not ride along with a presentation-only
change.
