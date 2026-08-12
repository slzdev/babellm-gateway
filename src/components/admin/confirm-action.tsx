'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { FormState } from './form-dialog'

export function ConfirmAction({
  trigger, open, onOpenChange, title, description,
  confirmLabel = 'Delete', successMessage, onConfirm,
}: {
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  successMessage: string
  /** Calls whichever server action; void-returning actions are fine. */
  onConfirm: () => Promise<FormState | void>
}) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const [pending, startTransition] = useTransition()
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : uncontrolled

  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolled(next)
    onOpenChange?.(next)
  }

  function confirm() {
    startTransition(async () => {
      try {
        const result = await onConfirm()
        if (result?.error) {
          toast.error(result.error)
          return
        }
        toast.success(result?.success ?? successMessage)
        setOpen(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong.')
      }
    })
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger render={trigger as React.ReactElement} /> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={confirm}>
            {pending ? 'Working…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
