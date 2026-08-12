'use client'

import { useActionState, useLayoutEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createKeyAction, type CreateKeyState } from './actions'

export function CreateKeyDialog({ users }: { users: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false)
  // True from the moment the create request goes in flight through until the
  // reveal step is dismissed. The key is persisted server-side (and hashed,
  // never shown again) as soon as the action starts running, not once the
  // reveal paints — so Escape, the backdrop, and the X must not be able to
  // close the dialog for the whole span, not just the tail end of it.
  const [busy, setBusy] = useState(false)

  function handleOpenChange(next: boolean) {
    if (!next && busy) return
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>Create key</DialogTrigger>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <CreateKeyBody
          users={users}
          onBusyChange={setBusy}
          onDone={() => {
            setBusy(false)
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Inside the portal, so each open starts fresh — including the reveal step. */
function CreateKeyBody({
  users, onDone, onBusyChange,
}: {
  users: Array<{ id: string; name: string }>
  onDone: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const [state, action, pending] = useActionState<CreateKeyState | undefined, FormData>(
    createKeyAction, undefined,
  )

  // The plaintext key is returned once and never again, so this dialog never
  // auto-closes on success — it swaps to a reveal the admin dismisses by hand.
  // useLayoutEffect (not useEffect) so the parent's close-gate is armed before
  // the browser paints — both while the submit is in flight and through the
  // reveal step, with no frame in between where the X or a stray Escape could
  // slip through. An action error brings pending back to false and leaves
  // plaintextKey unset, so busy drops back to false and the dialog is
  // dismissible again.
  useLayoutEffect(() => {
    onBusyChange(pending || Boolean(state?.plaintextKey))
  }, [pending, state?.plaintextKey, onBusyChange])

  if (state?.plaintextKey) {
    return <KeyReveal plaintextKey={state.plaintextKey} onDone={onDone} />
  }

  return (
    <form action={action} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Create an API key</DialogTitle>
        <DialogDescription>
          Rate limits and budgets are recorded but not enforced until Phase 4.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="production app" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="userId">User</Label>
          <select
            id="userId"
            name="userId"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">Unassigned</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="expiresAt">Expires</Label>
          <Input id="expiresAt" name="expiresAt" type="date" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rpmLimit">Requests / min</Label>
          <Input id="rpmLimit" name="rpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tpmLimit">Tokens / min</Label>
          <Input id="tpmLimit" name="tpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="budgetMonthlyUsd">Monthly budget (USD)</Label>
          <Input id="budgetMonthlyUsd" name="budgetMonthlyUsd" type="number" step="0.01" min={0} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="budgetTotalUsd">Total budget (USD)</Label>
          <Input id="budgetTotalUsd" name="budgetTotalUsd" type="number" step="0.01" min={0} />
        </div>
      </div>

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">{state.error}</p>
      ) : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</Button>
      </DialogFooter>
    </form>
  )
}

function KeyReveal({ plaintextKey, onDone }: { plaintextKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintextKey)
      setCopied(true)
      toast.success('Key copied to the clipboard.')
    } catch {
      // Clipboard access can be denied; the key is on screen either way.
      toast.error('Could not copy — select the key and copy it by hand.')
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>API key created</DialogTitle>
        <DialogDescription>
          Copy it now — it is never shown again.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-start gap-2 rounded-md border border-dashed p-3">
        <code className="flex-1 break-all font-mono text-sm">{plaintextKey}</code>
        <Button type="button" variant="outline" size="icon-sm" onClick={copy} aria-label="Copy key">
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}
