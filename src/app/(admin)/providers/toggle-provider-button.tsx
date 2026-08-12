'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { toggleProviderAction } from './actions'

export function ToggleProviderButton({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      try {
        await toggleProviderAction(id, !enabled)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the provider.')
      }
    })
  }

  return (
    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={handleClick}>
      {pending ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
    </Button>
  )
}
