'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import type { AdapterType } from '@/lib/adapters/credentials'
import { REGISTRY_NAMESPACE } from '@/lib/catalog/normalize'
import type { RegistryNamespace } from '@/lib/catalog/types'

const RegistryNamespaceContext = createContext<RegistryNamespace[]>([])

/**
 * The one namespace list every field reads. It is provided once per page rather
 * than passed to each field: the edit form draws a field per provider row, and
 * repeating ~180 entries down the table would be pure weight in the payload.
 */
export function RegistryNamespaceProvider({ namespaces, children }: {
  namespaces: RegistryNamespace[]
  children: ReactNode
}) {
  return (
    <RegistryNamespaceContext value={namespaces}>{children}</RegistryNamespaceContext>
  )
}

/**
 * The stored namespace has to stay selectable even when the list has lost it —
 * a cache-only slug disappears when the registry stops returning it. Without
 * this, opening the edit dialog and saving would silently clear the value.
 */
function withStored(namespaces: RegistryNamespace[], stored: string | null | undefined) {
  if (!stored || namespaces.some((ns) => ns.slug === stored)) return namespaces
  return [{ slug: stored, name: null }, ...namespaces]
}

/**
 * The models.dev namespace a provider's models are matched against, picked from
 * the namespaces the registry knows. A slug models.dev added since the last
 * registry fetch cannot be chosen until the cache catches up.
 *
 * Offers nothing unless a <RegistryNamespaceProvider> is an ancestor.
 */
export function RegistryNamespaceField({ id, adapter, defaultValue }: {
  id: string
  adapter: AdapterType
  defaultValue?: string | null
}) {
  const namespaces = useContext(RegistryNamespaceContext)
  const fallback = REGISTRY_NAMESPACE[adapter]

  const items = useMemo(() => withStored(namespaces, defaultValue), [namespaces, defaultValue])
  const selected = items.find((ns) => ns.slug === defaultValue) ?? null

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">Registry namespace</Label>
      <Combobox
        items={items}
        name="registryNamespace"
        defaultValue={selected}
        // The slug is the value the provider config stores, so it — not the
        // display name — is what the input shows and the form submits.
        itemToStringLabel={(ns: RegistryNamespace) => ns.slug}
        itemToStringValue={(ns: RegistryNamespace) => ns.slug}
        isItemEqualToValue={(a: RegistryNamespace, b: RegistryNamespace) => a.slug === b.slug}
        // Typing "anthropic" and typing "Anthropic" should both find the row,
        // and the default filter only looks at the label (the slug).
        filter={(ns: RegistryNamespace, query) => {
          const needle = query.trim().toLowerCase()
          return !needle
            || ns.slug.toLowerCase().includes(needle)
            || (ns.name?.toLowerCase().includes(needle) ?? false)
        }}
      >
        <ComboboxInput id={id} placeholder={fallback ?? 'e.g. xai'} showClear />
        <ComboboxContent>
          <ComboboxEmpty>No matching namespace.</ComboboxEmpty>
          <ComboboxList>
            {(ns: RegistryNamespace) => (
              <ComboboxItem key={ns.slug} value={ns}>
                <span className="truncate">{ns.slug}</span>
                {ns.name ? (
                  <span className="truncate text-xs text-muted-foreground">{ns.name}</span>
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
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
