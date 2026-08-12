'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { refreshRegistryAction, syncAllAction } from './actions'

export function SyncAllButton() {
  const [pending, start] = useTransition()

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => start(async () => {
        await syncAllAction()
        toast.success('Sync complete.')
      })}
    >
      {pending ? 'Syncing…' : 'Sync all'}
    </Button>
  )
}

export function RefreshRegistryButton() {
  const [pending, start] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => start(async () => {
        await refreshRegistryAction()
        toast.success('Registry refreshed.')
      })}
    >
      {pending ? 'Refreshing…' : 'Refresh registry'}
    </Button>
  )
}
