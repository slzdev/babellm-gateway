'use client'

import { useActionState, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * The shape every admin action already returns. Actions that report success
 * with a bare `{}` are the reason success is defined as "no error" rather
 * than "has a success message".
 */
export interface FormState {
  error?: string
  success?: string
  warning?: string
}

interface FormDialogProps<S extends FormState> {
  /** Omit when driving `open` yourself, e.g. from a dropdown menu item. */
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description?: string
  action: (prev: S | undefined, formData: FormData) => Promise<S>
  submitLabel: string
  pendingLabel?: string
  /** Toast text when the action succeeds without a message of its own. */
  successMessage: string
  className?: string
  children: React.ReactNode
  /**
   * Rendered as a sibling of the <form>, not inside it. For controls that are
   * themselves forms posting to a different action — nesting those would be
   * invalid HTML. See the catalog override dialog's Clear buttons.
   */
  extra?: React.ReactNode
}

export function FormDialog<S extends FormState>({
  trigger, open, onOpenChange, className, ...body
}: FormDialogProps<S>) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : uncontrolled
  // Reported up from the body: true while a submit is in flight. Closing
  // mid-submit doesn't just skip a success toast — on a failed submit the
  // body unmounts before its effect can show the inline error, so the admin
  // loses both the error message and everything they typed with no sign
  // anything went wrong.
  const [pending, setPending] = useState(false)

  // The Dialog's own onOpenChange (X, Escape, backdrop, the gated Cancel) —
  // refuses to close while a submit is in flight.
  function setOpen(next: boolean) {
    if (!next && pending) return
    if (!isControlled) setUncontrolled(next)
    onOpenChange?.(next)
  }

  // The success path's own close, wired to `onDone` below. It must NOT read
  // `pending`: the body's layout effect reports pending=false up to this
  // component, but React flushes a commit's passive effects (where the
  // success effect that calls onDone lives) before the render that
  // pending=false update causes has actually committed here — so at the
  // moment onDone runs, this component's own `pending` closure can still be
  // stale at `true`, and a check here would swallow the close. Closing
  // unconditionally sidesteps that staleness instead of racing it, the same
  // way key-form.tsx's Done button bypasses its dialog's close-gate directly.
  function closeFromAction() {
    if (!isControlled) setUncontrolled(false)
    onOpenChange?.(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger render={trigger as React.ReactElement} /> : null}
      <DialogContent className={cn('sm:max-w-lg', className)} showCloseButton={!pending}>
        <FormDialogBody {...body} onDone={closeFromAction} onPendingChange={setPending} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Rendered inside the portal, so Base UI unmounts it on close and each open
 * starts from a clean form with no stale action state.
 */
function FormDialogBody<S extends FormState>({
  title, description, action, submitLabel, pendingLabel, successMessage,
  children, extra, onDone, onPendingChange,
}: Omit<FormDialogProps<S>, 'trigger' | 'open' | 'onOpenChange' | 'className'> & {
  onDone: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const [state, formAction, pending] = useActionState<S | undefined, FormData>(
    action, undefined,
  )

  // useLayoutEffect so the shell's close-gate is armed before the browser
  // paints — no frame where a stray Escape or backdrop click could still
  // close the dialog while the action is running.
  useLayoutEffect(() => {
    onPendingChange(pending)
  }, [pending, onPendingChange])

  // Fires once per action result. The ref is load-bearing: `onDone` is a new
  // closure on every parent render, and useEffect re-runs on ANY dependency
  // change — so without it, `setOpen(false)` (and the revalidation that
  // follows every one of these actions) re-enters this effect while the popup
  // is still mounted through its exit animation, and toasts a second time.
  const handled = useRef<S | undefined>(undefined)

  useEffect(() => {
    if (!state || state.error) return
    if (handled.current === state) return
    handled.current = state
    toast.success(state.success ?? successMessage)
    // A save can succeed while the work it triggers (a re-sync) fails. That is
    // a second toast, not a reason to hold the dialog open.
    if (state.warning) toast.warning(state.warning)
    onDone()
  }, [state, successMessage, onDone])

  // The footer lives outside the <form> so `extra` can sit between them without
  // nesting one form inside another. The submit button reaches its form by id.
  const formId = useId()

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>

      <form id={formId} action={formAction} className="space-y-4">
        {children}
        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}
      </form>

      {extra}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
          Cancel
        </DialogClose>
        <Button type="submit" form={formId} disabled={pending}>
          {pending ? (pendingLabel ?? 'Saving…') : submitLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}
