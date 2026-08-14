'use client'

import { useState, useTransition } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmAction } from '@/components/admin/confirm-action'
import { deleteKeyAction, revokeKeyAction, setKeyPayloadLoggingAction } from './actions'

export function KeyRowActions({
  id, name, enabled, logPayloads,
}: {
  id: string
  name: string
  enabled: boolean
  logPayloads: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  function toggle() {
    startTransition(async () => {
      const formData = new FormData()
      formData.set('id', id)
      formData.set('enabled', String(!enabled))
      try {
        await revokeKeyAction(formData)
        toast.success(enabled ? 'Key revoked.' : 'Key restored.')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the key.')
      }
    })
  }

  function togglePayloadLogging() {
    startTransition(async () => {
      const formData = new FormData()
      formData.set('id', id)
      formData.set('logPayloads', String(!logPayloads))
      try {
        await setKeyPayloadLoggingAction(formData)
        toast.success(
          logPayloads
            ? 'Payload logging turned off.'
            : 'Payload logging turned on — requests and responses made with this key will be stored with its logs.',
        )
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update payload logging.')
      }
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem disabled={pending} onClick={toggle}>
            {enabled ? 'Revoke' : 'Restore'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={togglePayloadLogging}>
            {logPayloads ? 'Turn off payload logging' : 'Turn on payload logging'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="Any client still using this key starts receiving 401s. This cannot be undone."
        successMessage="Key deleted."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', id)
          await deleteKeyAction(formData)
        }}
      />
    </>
  )
}
