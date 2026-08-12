'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { syncProviderAction } from './actions'

export function SyncProviderButton({ id }: { id: string }) {
  const [pending, start] = useTransition()

  function handleClick() {
    start(async () => {
      try {
        const result = await syncProviderAction(id)
        if (result.status === 'ok') {
          toast.success('Sync finished.')
        } else if (result.status === 'unsupported') {
          // Not an error: this adapter has no model listing API yet.
          toast(result.error ?? 'This provider does not support model discovery.')
        } else {
          toast.error(result.error ?? 'Sync failed.')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not sync this provider.')
      }
    })
  }

  return (
    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={handleClick}>
      {pending ? 'Syncing…' : 'Sync models'}
    </Button>
  )
}
