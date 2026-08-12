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
        try {
          await syncAllAction()
          toast.success('Sync complete.')
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Sync failed.')
        }
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
        try {
          await refreshRegistryAction()
          toast.success('Registry refreshed.')
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Registry refresh failed.')
        }
      })}
    >
      {pending ? 'Refreshing…' : 'Refresh registry'}
    </Button>
  )
}
