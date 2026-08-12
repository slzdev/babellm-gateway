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
          const { ok, unsupported, failed } = await syncAllAction()
          const parts = [`${ok} synced`]
          if (unsupported > 0) parts.push(`${unsupported} unsupported`)
          if (failed > 0) parts.push(`${failed} failed`)
          const message = `${parts.join(', ')}.`
          if (failed > 0) toast.error(message)
          else toast.success(message)
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
          const { status, error } = await refreshRegistryAction()
          if (error) toast.error(error)
          else if (status === 'disabled') toast('Registry is disabled — nothing to refresh.')
          else toast.success('Registry refreshed.')
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Registry refresh failed.')
        }
      })}
    >
      {pending ? 'Refreshing…' : 'Refresh registry'}
    </Button>
  )
}
