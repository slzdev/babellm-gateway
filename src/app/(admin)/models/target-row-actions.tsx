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
import type { PickerGroup } from '@/lib/admin/catalog'
import type { BreakerState } from '@/lib/health'
import type { ServiceTier } from '@/lib/service-tiers'
import { removeTargetAction, resetTargetBreakerAction, toggleTargetAction } from './actions'
import { EditTargetDialog } from './edit-target-form'

export function TargetRowActions({
  target,
  virtualModelId,
  groups,
  breakerState,
  globalThreshold,
  globalCooldown,
}: {
  target: {
    id: string
    upstreamModel: string
    priority: number
    weight: number
    serviceTier: ServiceTier | null
    enabled: boolean
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
  }
  /** Only for revalidation — every mutation has to refresh this model's page. */
  virtualModelId: string
  groups: PickerGroup[]
  breakerState: BreakerState
  /** The global breaker settings, passed through to the edit dialog as
   *  placeholders for what a blank override field would inherit. */
  globalThreshold: number
  globalCooldown: number
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  function toggle() {
    startTransition(async () => {
      // A bare await here is an unhandled rejection with no user feedback —
      // see target-enabled-toggle.tsx, which this menu item replaces.
      try {
        await toggleTargetAction(target.id, !target.enabled, virtualModelId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the target.')
      }
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${target.upstreamModel}`} />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={() => setEditing(true)}>Edit</DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={toggle}>
            {target.enabled ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuItem
            // Disabled when closed rather than hidden: a reset that silently
            // does nothing reads as a broken button.
            disabled={breakerState === 'closed' || pending}
            onSelect={() => {
              startTransition(async () => {
                const data = new FormData()
                data.set('id', target.id)
                data.set('virtualModelId', virtualModelId)
                try {
                  await resetTargetBreakerAction(data)
                  toast.success('Breaker reset.')
                } catch {
                  toast.error('Could not reset the breaker.')
                }
              })
            }}
          >
            Reset breaker
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditTargetDialog
        target={target}
        virtualModelId={virtualModelId}
        groups={groups}
        globalThreshold={globalThreshold}
        globalCooldown={globalCooldown}
        open={editing}
        onOpenChange={setEditing}
      />

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${target.upstreamModel}?`}
        description="This route target stops receiving requests. This cannot be undone."
        confirmLabel="Remove"
        successMessage="Target removed."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', target.id)
          formData.set('virtualModelId', virtualModelId)
          await removeTargetAction(formData)
        }}
      />
    </>
  )
}
