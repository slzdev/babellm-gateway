'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FormDialog } from '@/components/admin/form-dialog'
import type { PickerGroup } from '@/lib/admin/catalog'
import type { ApiFlavor } from '@/lib/api-flavors'
import { ApiFlavorSelect } from './api-flavor-select'
import { ModelCombobox } from './model-combobox'
import { ServiceTierSelect } from './service-tier-select'
import { addTargetAction, createModelAction, type ActionState } from './actions'

const POLICIES = ['failover', 'weighted', 'round_robin'] as const

export function CreateModelDialog() {
  return (
    <FormDialog<ActionState>
      trigger={<Button>Add virtual model</Button>}
      title="Add a virtual model"
      action={createModelAction}
      submitLabel="Add model"
      successMessage="Virtual model created."
    >
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
    </FormDialog>
  )
}

export function AddTargetDialog({
  virtualModelId,
  providers,
  groupsByProvider,
  globalThreshold,
  globalCooldown,
}: {
  virtualModelId: string
  providers: Array<{ id: string; name: string; apiFlavor: ApiFlavor }>
  groupsByProvider: Record<string, PickerGroup[]>
  /** The global breaker settings, shown as placeholders so an operator can
   *  see what a blank field would inherit without looking it up elsewhere. */
  globalThreshold: number
  globalCooldown: number
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const selectedProvider = providers.find((provider) => provider.id === providerId)

  return (
    <FormDialog<ActionState>
      trigger={<Button variant="outline" size="sm">Add target</Button>}
      title="Add a route target"
      action={addTargetAction}
      submitLabel="Add target"
      successMessage="Target added."
    >
      <input type="hidden" name="virtualModelId" value={virtualModelId} />
      <div className="space-y-2">
        <Label htmlFor={`provider-${virtualModelId}`}>Provider</Label>
        <select
          id={`provider-${virtualModelId}`}
          name="providerId"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`upstream-${virtualModelId}`}>Upstream model</Label>
        <ModelCombobox
          id={`upstream-${virtualModelId}`}
          name="upstreamModel"
          groups={groupsByProvider[providerId] ?? []}
        />
      </div>
      <div className="grid gap-4 grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`priority-${virtualModelId}`}>Priority</Label>
          <Input id={`priority-${virtualModelId}`} name="priority" type="number" defaultValue={0} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`weight-${virtualModelId}`}>Weight</Label>
          <Input id={`weight-${virtualModelId}`} name="weight" type="number" defaultValue={100} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`tier-${virtualModelId}`}>Service tier</Label>
        <ServiceTierSelect id={`tier-${virtualModelId}`} />
        <p className="text-xs text-muted-foreground">
          Sent upstream as <code>service_tier</code>, replacing any value the client sent.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`flavor-${virtualModelId}`}>API flavor</Label>
        <ApiFlavorSelect
          id={`flavor-${virtualModelId}`}
          providerDefault={selectedProvider?.apiFlavor ?? 'chat_completions'}
        />
        <p className="text-xs text-muted-foreground">
          Which endpoint this target is called on. Only meaningful for OpenAI-shaped providers.
        </p>
      </div>
      <div className="grid gap-4 grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`breaker-threshold-${virtualModelId}`}>Breaker threshold</Label>
          <Input
            id={`breaker-threshold-${virtualModelId}`}
            name="breakerThreshold"
            type="number"
            min={0}
            placeholder={`${globalThreshold} (inherited)`}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`breaker-cooldown-${virtualModelId}`}>Breaker cooldown (s)</Label>
          <Input
            id={`breaker-cooldown-${virtualModelId}`}
            name="breakerCooldownSeconds"
            type="number"
            min={1}
            placeholder={`${globalCooldown} (inherited)`}
          />
        </div>
      </div>
    </FormDialog>
  )
}
