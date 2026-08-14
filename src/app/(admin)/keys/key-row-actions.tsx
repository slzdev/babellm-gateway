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
import type { ApiKeyListItem } from '@/lib/admin/keys'
import {
  deleteKeyAction, resetKeyUsageAction, revokeKeyAction, rotateKeyAction,
  setKeyPayloadLoggingAction,
} from './actions'
import { EditKeyDialog } from './edit-key-form'
import { KeyRevealDialog } from './key-reveal'

export function KeyRowActions({
  apiKey, users,
}: {
  apiKey: ApiKeyListItem
  users: Array<{ id: string; name: string }>
}) {
  const { id, name, enabled, logPayloads } = apiKey
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState<'delete' | 'rotate' | 'reset' | null>(null)
  // Set only by a rotation that succeeded — the new secret, on screen once.
  const [rotatedKey, setRotatedKey] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function withId(): FormData {
    const formData = new FormData()
    formData.set('id', id)
    return formData
  }

  function toggle() {
    startTransition(async () => {
      const formData = withId()
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
      const formData = withId()
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
          <DropdownMenuItem onClick={() => setEditing(true)}>Edit</DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={toggle}>
            {enabled ? 'Revoke' : 'Restore'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={togglePayloadLogging}>
            {logPayloads ? 'Turn off payload logging' : 'Turn on payload logging'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConfirming('reset')}>Reset usage</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setConfirming('rotate')}>Rotate key</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming('delete')}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditKeyDialog apiKey={apiKey} users={users} open={editing} onOpenChange={setEditing} />

      <ConfirmAction
        open={confirming === 'reset'}
        onOpenChange={(open) => setConfirming(open ? 'reset' : null)}
        title={`Reset usage for ${name}?`}
        description="Zeroes this key's rate-limit windows and its monthly and total spend. The requests it already made stay in the logs."
        confirmLabel="Reset usage"
        successMessage="Usage counters reset."
        onConfirm={() => resetKeyUsageAction(withId())}
      />

      <ConfirmAction
        open={confirming === 'rotate'}
        onOpenChange={(open) => setConfirming(open ? 'rotate' : null)}
        title={`Rotate ${name}?`}
        description="Issues a new secret and shows it once. Any client still using the current secret starts receiving 401s immediately. Limits, budgets, and usage stay with the key."
        confirmLabel="Rotate key"
        successMessage="Key rotated."
        onConfirm={async () => {
          const result = await rotateKeyAction(withId())
          if (result.plaintextKey) setRotatedKey(result.plaintextKey)
          return result
        }}
      />

      <ConfirmAction
        open={confirming === 'delete'}
        onOpenChange={(open) => setConfirming(open ? 'delete' : null)}
        title={`Delete ${name}?`}
        description="Any client still using this key starts receiving 401s. This cannot be undone."
        successMessage="Key deleted."
        onConfirm={() => deleteKeyAction(withId())}
      />

      <KeyRevealDialog plaintextKey={rotatedKey} onDone={() => setRotatedKey(null)} />
    </>
  )
}
