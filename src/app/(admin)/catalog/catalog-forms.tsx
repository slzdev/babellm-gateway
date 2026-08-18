'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiFlavorSelect } from '@/components/admin/api-flavor-select'
import { FormDialog } from '@/components/admin/form-dialog'
import type { CatalogListItem } from '@/lib/admin/catalog'
import { MODEL_PATH_FIELDS } from '@/lib/adapters/openai/paths'
import {
  addManualModelAction, clearOverrideAction, routeToModelAction,
  saveRegistrySettingsAction, setModelGatewayAction, setOverrideAction, type ActionState,
} from './actions'

function Message({ state }: { state: ActionState | undefined }) {
  if (state?.error) return <p role="alert" className="text-sm text-destructive">{state.error}</p>
  if (state?.success) return <p role="status" className="text-sm text-muted-foreground">{state.success}</p>
  return null
}

const NUMERIC_LABELS = [
  ['contextWindow', 'Context window'],
  ['maxOutputTokens', 'Max output tokens'],
  ['inputPerMtok', 'Input $/Mtok'],
  ['outputPerMtok', 'Output $/Mtok'],
  ['cachedInputPerMtok', 'Cached input $/Mtok'],
] as const

/** A field currently has an override when its key is present in item.override. */
function ClearOverrideButton({
  id, field, label,
}: {
  id: string
  field: keyof CatalogListItem['override']
  label: string
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    clearOverrideAction, undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
  }, [state])

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="field" value={field} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Clearing…' : `Clear ${label.toLowerCase()}`}
      </Button>
    </form>
  )
}

export function OverrideDialog({
  item, open, onOpenChange,
}: {
  item: CatalogListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const overriddenFields = NUMERIC_LABELS.filter(([field]) => field in item.override)

  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl"
      title={`Override ${item.modelId}`}
      description={
        item.canonicalKey
          ? `Matched ${item.canonicalKey}. Overrides always win and survive re-syncs.`
          : 'No registry match — set a registry namespace on the provider, or fill these in by hand.'
      }
      action={setOverrideAction}
      submitLabel="Save override"
      successMessage="Override saved."
      extra={
        overriddenFields.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {overriddenFields.map(([field, label]) => (
              <ClearOverrideButton key={field} id={item.id} field={field} label={label} />
            ))}
          </div>
        ) : null
      }
    >
      <input type="hidden" name="id" value={item.id} />
      <div className="grid gap-4 sm:grid-cols-3">
        {NUMERIC_LABELS.map(([field, label]) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`${item.id}-${field}`} className="text-xs">{label}</Label>
            <Input
              id={`${item.id}-${field}`}
              name={field}
              type="number"
              step="any"
              min="0"
              defaultValue={item.override[field] ?? ''}
              placeholder={item[field] === null ? '—' : String(item[field])}
            />
            <p className="text-xs text-muted-foreground">
              {item.sources[field] ? `now from ${item.sources[field]}` : 'not known'}
            </p>
          </div>
        ))}
      </div>
    </FormDialog>
  )
}

export function GatewaySettingsDialog({
  item, open, onOpenChange,
}: {
  item: CatalogListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      title={`Gateway settings for ${item.modelId}`}
      description={`How the gateway calls this model on ${item.providerName}, whichever route reaches it. Blank inherits the provider.`}
      action={setModelGatewayAction}
      submitLabel="Save settings"
      successMessage="Gateway settings saved."
    >
      <input type="hidden" name="id" value={item.id} />

      <div className="space-y-2">
        <Label htmlFor={`gateway-flavor-${item.id}`}>API flavor</Label>
        <ApiFlavorSelect
          id={`gateway-flavor-${item.id}`}
          defaultValue={item.apiFlavor}
          providerDefault={item.providerApiFlavor}
        />
        <p className="text-xs text-muted-foreground">
          Which endpoint this model is called on. Only meaningful for OpenAI-shaped providers.
        </p>
      </div>

      {MODEL_PATH_FIELDS.map((field) => (
        <div key={field.name} className="space-y-2">
          <Label htmlFor={`gateway-${field.name}-${item.id}`}>{field.label}</Label>
          <Input
            id={`gateway-${field.name}-${item.id}`}
            name={field.name}
            defaultValue={item[field.name] ?? ''}
            placeholder={item.providerPaths[field.name]}
          />
          <p className="text-xs text-muted-foreground">{field.help}</p>
        </div>
      ))}
    </FormDialog>
  )
}

export function RouteToModelDialog({
  item, virtualModels, open, onOpenChange,
}: {
  item: CatalogListItem
  virtualModels: Array<{ id: string; name: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      title={`Route to ${item.modelId}`}
      description="Adds this model as a route target on a virtual model."
      action={routeToModelAction}
      submitLabel="Create route"
      successMessage="Route created."
    >
      <input type="hidden" name="providerId" value={item.providerId} />
      <input type="hidden" name="modelId" value={item.modelId} />

      <div className="space-y-2">
        <Label htmlFor={`route-${item.id}`}>Route to</Label>
        <select
          id={`route-${item.id}`}
          name="virtualModelId"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">— new virtual model —</option>
          {virtualModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`route-name-${item.id}`}>New name</Label>
        <Input id={`route-name-${item.id}`} name="newModelName" placeholder="house-model" />
      </div>
    </FormDialog>
  )
}

export function AddManualModelDialog({
  providers,
}: {
  providers: Array<{ id: string; name: string }>
}) {
  return (
    <FormDialog<ActionState>
      trigger={<Button size="sm">Add model</Button>}
      title="Add a model by hand"
      action={addManualModelAction}
      submitLabel="Add model"
      successMessage="Model added."
    >
      <div className="space-y-2">
        <Label htmlFor="manual-provider">Provider</Label>
        <select
          id="manual-provider"
          name="providerId"
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="manual-model">Model id</Label>
        <Input id="manual-model" name="modelId" required placeholder="internal-llm-v2" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="manual-context">Context window</Label>
        <Input id="manual-context" name="contextWindow" type="number" min="0" />
      </div>
    </FormDialog>
  )
}

export function RegistrySettingsForm({
  registryEnabled,
  registryUrl,
  fetchedAt,
  status,
}: {
  registryEnabled: boolean
  registryUrl: string
  fetchedAt: Date | null
  status: string
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    saveRegistrySettingsAction, undefined,
  )

  return (
    <form action={action} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">Model registry</h2>
      <div className="flex items-center gap-2">
        <Switch id="registryEnabled" name="registryEnabled" defaultChecked={registryEnabled} />
        <Label htmlFor="registryEnabled">Enrich the catalog from an external registry</Label>
      </div>
      <div className="space-y-1">
        <Label htmlFor="registryUrl" className="text-xs">Registry URL</Label>
        <Input id="registryUrl" name="registryUrl" defaultValue={registryUrl} className="max-w-lg" />
      </div>
      <p className="text-sm text-muted-foreground">
        {fetchedAt
          ? `Last fetched ${fetchedAt.toISOString()} (${status}).`
          : 'Never fetched — the catalog is using the bundled snapshot.'}
      </p>
      <Message state={state} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}
