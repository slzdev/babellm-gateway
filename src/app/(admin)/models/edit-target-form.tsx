'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PickerGroup } from '@/lib/admin/catalog'
import { ModelCombobox } from './model-combobox'
import { updateTargetAction, type ActionState } from './actions'

export function EditTargetForm({
  target,
  groups,
}: {
  target: { id: string; upstreamModel: string; priority: number; weight: number }
  groups: PickerGroup[]
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateTargetAction, undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">Edit</summary>
      <form action={action} className="flex flex-wrap items-end gap-2 py-2">
        <input type="hidden" name="id" value={target.id} />
        <div className="space-y-1">
          <Label htmlFor={`edit-model-${target.id}`} className="text-xs">Upstream model</Label>
          <ModelCombobox
            id={`edit-model-${target.id}`}
            name="upstreamModel"
            groups={groups}
            defaultValue={target.upstreamModel}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-priority-${target.id}`} className="text-xs">Priority</Label>
          <Input
            id={`edit-priority-${target.id}`} name="priority" type="number"
            defaultValue={target.priority} className="w-24"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-weight-${target.id}`} className="text-xs">Weight</Label>
          <Input
            id={`edit-weight-${target.id}`} name="weight" type="number"
            defaultValue={target.weight} className="w-24"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </details>
  )
}
