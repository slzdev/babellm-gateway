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
  open,
  onOpenChange,
}: {
  target: {
    id: string
    upstreamModel: string
    priority: number
    weight: number
    serviceTier: ServiceTier | null
  }
  virtualModelId: string
  groups: PickerGroup[]
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
    </FormDialog>
  )
}
