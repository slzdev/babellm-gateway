'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { CatalogListItem } from '@/lib/admin/catalog'
import {
  addManualModelAction, saveRegistrySettingsAction, setOverrideAction,
  type ActionState,
} from './actions'

function Message({ state }: { state: ActionState | undefined }) {
  if (state?.error) return <p role="alert" className="text-sm text-destructive">{state.error}</p>
  if (state?.success) return <p className="text-sm text-muted-foreground">{state.success}</p>
  return null
}

const NUMERIC_LABELS = [
  ['contextWindow', 'Context window'],
  ['maxOutputTokens', 'Max output tokens'],
  ['inputPerMtok', 'Input $/Mtok'],
  ['outputPerMtok', 'Output $/Mtok'],
  ['cachedInputPerMtok', 'Cached input $/Mtok'],
] as const

export function OverrideForm({ item }: { item: CatalogListItem }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    setOverrideAction, undefined,
  )

  return (
    <form action={action} className="space-y-3 pt-2">
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
