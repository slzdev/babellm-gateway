'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FormDialog } from '@/components/admin/form-dialog'
import type { PickerGroup } from '@/lib/admin/catalog'
import type { ServiceTier } from '@/lib/service-tiers'
import { ModelCombobox } from './model-combobox'
import { ServiceTierSelect } from './service-tier-select'
import { updateTargetAction, type ActionState } from './actions'

export function EditTargetDialog({
  target,
  virtualModelId,
  groups,
  globalThreshold,
  globalCooldown,
  open,
  onOpenChange,
}: {
  target: {
    id: string
    upstreamModel: string
    priority: number
    weight: number
    serviceTier: ServiceTier | null
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
  }
  virtualModelId: string
  groups: PickerGroup[]
  /** The global breaker settings, shown as placeholders so an operator can
   *  see what a blank field would inherit without looking it up elsewhere. */
  globalThreshold: number
  globalCooldown: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      title="Edit route target"
      action={updateTargetAction}
      submitLabel="Save"
      successMessage="Target updated."
    >
      <input type="hidden" name="id" value={target.id} />
      <input type="hidden" name="virtualModelId" value={virtualModelId} />
      <div className="space-y-2">
        <Label htmlFor={`edit-model-${target.id}`}>Upstream model</Label>
        <ModelCombobox
          id={`edit-model-${target.id}`}
          name="upstreamModel"
          groups={groups}
          defaultValue={target.upstreamModel}
        />
      </div>
      <div className="grid gap-4 grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`edit-priority-${target.id}`}>Priority</Label>
          <Input
            id={`edit-priority-${target.id}`} name="priority" type="number"
            defaultValue={target.priority}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`edit-weight-${target.id}`}>Weight</Label>
          <Input
            id={`edit-weight-${target.id}`} name="weight" type="number"
            defaultValue={target.weight}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`edit-tier-${target.id}`}>Service tier</Label>
        <ServiceTierSelect id={`edit-tier-${target.id}`} defaultValue={target.serviceTier} />
        <p className="text-xs text-muted-foreground">
          Sent upstream as <code>service_tier</code>, replacing any value the client sent.
        </p>
      </div>
      <div className="grid gap-4 grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`edit-breaker-threshold-${target.id}`}>Breaker threshold</Label>
          <Input
            id={`edit-breaker-threshold-${target.id}`}
            name="breakerThreshold"
            type="number"
            min={0}
            defaultValue={target.breakerThreshold ?? ''}
            placeholder={`${globalThreshold} (inherited)`}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`edit-breaker-cooldown-${target.id}`}>Breaker cooldown (s)</Label>
          <Input
            id={`edit-breaker-cooldown-${target.id}`}
            name="breakerCooldownSeconds"
            type="number"
            min={1}
            defaultValue={target.breakerCooldownSeconds ?? ''}
            placeholder={`${globalCooldown} (inherited)`}
          />
        </div>
      </div>
    </FormDialog>
  )
}
