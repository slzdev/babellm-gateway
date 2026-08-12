'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmAction } from '@/components/admin/confirm-action'
import type { ProviderListItem } from '@/lib/admin/providers'
import {
  deleteProviderAction, syncProviderAction, testProviderAction,
  toggleProviderAction, type ActionState,
} from './actions'
import { EditProviderDialog } from './edit-provider-form'

export function ProviderRowActions({ provider }: { provider: ProviderListItem }) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  function sync() {
    startTransition(async () => {
      try {
        const result = await syncProviderAction(provider.id)
        if (result.status === 'ok') toast.success('Sync finished.')
        else if (result.status === 'unsupported') {
          toast(result.error ?? 'This provider does not support model discovery.')
        } else toast.error(result.error ?? 'Sync failed.')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not sync this provider.')
      }
    })
  }

  function toggle() {
    startTransition(async () => {
      // The deleted toggle-provider-button.tsx caught here. Folding the button
      // into a menu item must not quietly drop that: without the catch, a
      // failed toggle is an unhandled rejection with no user feedback at all.
      try {
        await toggleProviderAction(provider.id, !provider.enabled)
        toast.success(provider.enabled ? 'Provider disabled.' : 'Provider enabled.')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the provider.')
      }
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${provider.name}`} />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={() => setEditing(true)}>Edit</DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={sync}>Sync models</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTesting(true)}>Test connection</DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={toggle}>
            {provider.enabled ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditProviderDialog provider={provider} open={editing} onOpenChange={setEditing} />

      <TestConnectionDialog
        providerId={provider.id}
        providerName={provider.name}
        open={testing}
        onOpenChange={setTesting}
      />

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${provider.name}?`}
        description={
          provider.targetCount > 0
            ? `${provider.targetCount} route target(s) point at this provider and will stop resolving. This cannot be undone.`
            : 'Its catalog entries and stored credentials are removed. This cannot be undone.'
        }
        successMessage="Provider deleted."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', provider.id)
          return deleteProviderAction(undefined, formData)
        }}
      />
    </>
  )
}

/**
 * Test needs an upstream model name, so it gets a dialog rather than a bare
 * menu action. It reports through toasts and never mutates anything.
 */
function TestConnectionDialog({
  providerId, providerName, open, onOpenChange,
}: {
  providerId: string
  providerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    testProviderAction, undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form action={action} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Test {providerName}</DialogTitle>
          </DialogHeader>
          <input type="hidden" name="id" value={providerId} />
          <div className="space-y-2">
            <Label htmlFor={`test-${providerId}`}>Upstream model</Label>
            <Input
              id={`test-${providerId}`}
              name="upstreamModel"
              required
              placeholder="gpt-4o-mini"
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
            <Button type="submit" disabled={pending}>{pending ? 'Testing…' : 'Test'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
