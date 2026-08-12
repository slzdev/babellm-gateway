'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { CatalogListItem } from '@/lib/admin/catalog'
import {
  addManualModelAction, clearOverrideAction, deleteCatalogModelAction,
  routeToModelAction, saveRegistrySettingsAction, setOverrideAction, type ActionState,
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

export function OverrideForm({ item }: { item: CatalogListItem }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    setOverrideAction, undefined,
  )
  const overriddenFields = NUMERIC_LABELS.filter(([field]) => field in item.override)

  return (
    <div className="space-y-2 pt-2">
      <form action={action} className="space-y-3">
        <input type="hidden" name="id" value={item.id} />
        <div className="grid gap-3 sm:grid-cols-3">
          {NUMERIC_LABELS.map(([field, label]) => (
            <div key={field} className="space-y-1">
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
        <Message state={state} />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save override'}
        </Button>
      </form>
      {overriddenFields.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {overriddenFields.map(([field, label]) => (
            <ClearOverrideButton key={field} id={item.id} field={field} label={label} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function DeleteCatalogModelButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    deleteCatalogModelAction, undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
  }, [state])

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Deleting…' : 'Delete'}
      </Button>
    </form>
  )
}

export function AddManualModelForm({
  providers,
}: {
  providers: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    addManualModelAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor="manual-provider" className="text-xs">Provider</Label>
        <select
          id="manual-provider"
          name="providerId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="manual-model" className="text-xs">Model id</Label>
        <Input id="manual-model" name="modelId" required placeholder="internal-llm-v2" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="manual-context" className="text-xs">Context window</Label>
        <Input id="manual-context" name="contextWindow" type="number" min="0" className="w-32" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Adding…' : 'Add model'}
      </Button>
      <div className="w-full"><Message state={state} /></div>
    </form>
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

export function RouteToModelForm({
  item,
  virtualModels,
}: {
  item: CatalogListItem
  virtualModels: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    routeToModelAction, undefined,
  )

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t pt-3">
      <input type="hidden" name="providerId" value={item.providerId} />
      <input type="hidden" name="modelId" value={item.modelId} />

      <div className="space-y-1">
        <Label htmlFor={`route-${item.id}`} className="text-xs">Route to</Label>
        <select
          id={`route-${item.id}`}
          name="virtualModelId"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">— new virtual model —</option>
          {virtualModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`route-name-${item.id}`} className="text-xs">New name</Label>
        <Input id={`route-name-${item.id}`} name="newModelName" placeholder="house-model" />
      </div>

      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Creating…' : 'Route to this'}
      </Button>
      <div className="w-full"><Message state={state} /></div>
    </form>
  )
}
