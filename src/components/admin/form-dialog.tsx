'use client'

import { useActionState, useEffect, useId, useState } from 'react'
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

  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolled(next)
    onOpenChange?.(next)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger render={trigger as React.ReactElement} /> : null}
      <DialogContent className={cn('sm:max-w-lg', className)}>
        <FormDialogBody {...body} onDone={() => setOpen(false)} />
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
  children, extra, onDone,
}: Omit<FormDialogProps<S>, 'trigger' | 'open' | 'onOpenChange' | 'className'> & {
  onDone: () => void
}) {
  const [state, formAction, pending] = useActionState<S | undefined, FormData>(
    action, undefined,
  )

  useEffect(() => {
    if (!state || state.error) return
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
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" form={formId} disabled={pending}>
          {pending ? (pendingLabel ?? 'Saving…') : submitLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}
