'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { toggleTargetAction } from './actions'

export function TargetEnabledToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      try {
        await toggleTargetAction(id, !enabled)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the target.')
      }
    })
  }

  return (
    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={handleClick}>
      {pending ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
    </Button>
  )
}
