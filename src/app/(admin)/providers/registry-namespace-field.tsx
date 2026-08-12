'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdapterType } from '@/lib/adapters/credentials'
import { REGISTRY_NAMESPACE } from '@/lib/catalog/normalize'
import type { RegistryNamespace } from '@/lib/catalog/types'

/**
 * The one datalist every namespace field points at. It is rendered once per
 * page rather than once per field: the edit form draws a field per provider
 * row, and repeating ~180 options down the table would be pure weight.
 */
export const REGISTRY_NAMESPACE_LIST_ID = 'registry-namespaces'

export function RegistryNamespaceDatalist({ namespaces }: { namespaces: RegistryNamespace[] }) {
  return (
    <datalist id={REGISTRY_NAMESPACE_LIST_ID}>
      {namespaces.map(({ slug, name }) => (
        // The name is the option's text rather than a `label` attribute, which
        // is the form browsers render most consistently.
        <option key={slug} value={slug}>{name}</option>
      ))}
    </datalist>
  )
}

/**
 * The models.dev namespace a provider's models are matched against. Free text
 * on purpose: the suggestion list is only as current as the last registry
 * fetch, so a namespace added upstream yesterday must still be typeable today.
 *
 * Inert unless a <RegistryNamespaceDatalist> is rendered somewhere on the same
 * page — the browser silently drops a `list` pointing at nothing.
 */
export function RegistryNamespaceField({ id, adapter, defaultValue }: {
  id: string
  adapter: AdapterType
  defaultValue?: string | null
}) {
  const fallback = REGISTRY_NAMESPACE[adapter]

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">Registry namespace</Label>
      <Input
        id={id}
        name="registryNamespace"
        list={REGISTRY_NAMESPACE_LIST_ID}
        defaultValue={defaultValue ?? ''}
        placeholder={fallback ?? 'xai'}
      />
      <p className="text-xs text-muted-foreground">
        models.dev namespace for enriching this provider&apos;s models with pricing and
        limits.{' '}
        {fallback
          ? <>Blank uses <code>{fallback}</code>.</>
          : <>This adapter has no default — blank means no enrichment.</>}
      </p>
    </div>
  )
}
