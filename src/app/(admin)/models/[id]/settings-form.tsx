'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { RoutingPolicy, VirtualModelListItem } from '@/lib/admin/models'
import { updateModelAction, type ActionState } from '../actions'

// Priority always groups the targets into tiers and the tiers are always tried
// lowest-first; the policy only orders the targets inside one. The hints say
// "within a priority" so the two columns don't read as rival orderings.
const POLICIES: Array<{ value: RoutingPolicy; label: string; hint: string }> = [
  { value: 'failover', label: 'failover', hint: 'Try targets in priority order, falling through on failure.' },
  { value: 'weighted', label: 'weighted', hint: 'Within a priority, spread requests in proportion to weight. Lower priorities are tried first.' },
  { value: 'round_robin', label: 'round_robin', hint: 'Within a priority, take each enabled target in turn. Lower priorities are tried first.' },
]

export function SettingsForm({ model }: { model: VirtualModelListItem }) {
  const [state, formAction, pending] = useActionState<ActionState | undefined, FormData>(
    updateModelAction, undefined,
  )

  // Controlled, unlike its uncontrolled neighbours: saving revalidates and hands
  // the Select a different `defaultValue` on a form that hasn't remounted, which
  // Base UI warns about. Holding the value here also keeps the hint in sync with
  // the pick instead of with the last save.
  const [policy, setPolicy] = useState<RoutingPolicy>(model.policy)

  // One toast per result. Without the ref the effect re-fires on the render
  // that revalidation causes and toasts twice — the same guard FormDialogBody
  // needs for the dialog actions.
  const handled = useRef<ActionState | undefined>(undefined)
  useEffect(() => {
    if (!state || state.error) return
    if (handled.current === state) return
    handled.current = state
    toast.success(state.success ?? 'Virtual model saved.')
  }, [state])

  return (
    // `key` on the form, not the fields: after a rename the server sends fresh
    // defaults, and remounting is what lets uncontrolled inputs pick them up.
    <form key={model.name} action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={model.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required defaultValue={model.name} />
          <p className="text-xs text-muted-foreground">
            The model name clients send in their requests.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" defaultValue={model.description ?? ''} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="policy">Load balancing</Label>
          <Select
            name="policy"
            value={policy}
            // Base UI types the change value as nullable for clearable selects;
            // this one has no empty item, so a null can only be spurious.
            onValueChange={(value) => { if (value) setPolicy(value) }}
          >
            <SelectTrigger id="policy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICIES.map((policy) => (
                <SelectItem key={policy.value} value={policy.value}>{policy.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {POLICIES.find((p) => p.value === policy)?.hint}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="maxAttempts">Max attempts</Label>
          <Input
            id="maxAttempts" name="maxAttempts" type="number" min={1} required
            defaultValue={model.maxAttempts}
          />
          <p className="text-xs text-muted-foreground">
            How many targets a single request may try before giving up.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t pt-4">
        <Switch id="enabled" name="enabled" defaultChecked={model.enabled} />
        <Label htmlFor="enabled" className="font-normal">
          Enabled — a disabled model refuses requests
        </Label>

        <Button type="submit" className="ml-auto" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  )
}
