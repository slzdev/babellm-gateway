'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addTargetAction, createModelAction, type ActionState } from './actions'

const POLICIES = ['failover', 'weighted', 'round_robin'] as const

export function CreateModelForm() {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createModelAction, undefined,
  )

  return (
    <form action={action} className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Add a virtual model</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="house-model" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="policy">Policy</Label>
          <select id="policy" name="policy" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
            {POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
          </select>
        </div>
      </div>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Add model'}</Button>
    </form>
  )
}

export function AddTargetForm({
  virtualModelId,
  providers,
}: {
  virtualModelId: string
  providers: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    addTargetAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 pt-2">
      <input type="hidden" name="virtualModelId" value={virtualModelId} />
      <div className="space-y-1">
        <Label htmlFor={`provider-${virtualModelId}`} className="text-xs">Provider</Label>
        <select
          id={`provider-${virtualModelId}`}
          name="providerId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`upstream-${virtualModelId}`} className="text-xs">Upstream model</Label>
        <Input id={`upstream-${virtualModelId}`} name="upstreamModel" required placeholder="gpt-4o-mini" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`priority-${virtualModelId}`} className="text-xs">Priority</Label>
        <Input id={`priority-${virtualModelId}`} name="priority" type="number" defaultValue={0} className="w-24" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`weight-${virtualModelId}`} className="text-xs">Weight</Label>
        <Input id={`weight-${virtualModelId}`} name="weight" type="number" defaultValue={100} className="w-24" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>Add target</Button>
      {state?.error ? <p role="alert" className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  )
}
