'use client'

import { useActionState, useLayoutEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { createKeyAction, type CreateKeyState } from './actions'
import { KeyFields } from './key-fields'
import { KeyReveal } from './key-reveal'

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
    return (
      <KeyReveal
        title="API key created"
        description="Copy it now — it is never shown again."
        plaintextKey={state.plaintextKey}
        onDone={onDone}
      />
    )
  }

  return (
    <form action={action} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Create an API key</DialogTitle>
        <DialogDescription>
          Rate limits and budgets are enforced on every request this key makes.
        </DialogDescription>
      </DialogHeader>

      <KeyFields users={users} />

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">{state.error}</p>
      ) : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</Button>
      </DialogFooter>
    </form>
  )
}
