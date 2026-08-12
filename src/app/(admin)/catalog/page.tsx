import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listCatalog, type CatalogListItem } from '@/lib/admin/catalog'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { getCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { modelKinds, type ModelKind } from '@/lib/catalog/types'
import { deleteCatalogModelAction } from './actions'
import { AddManualModelForm, OverrideForm, RegistrySettingsForm } from './catalog-forms'
import { RefreshRegistryButton, SyncAllButton } from './sync-buttons'

export const dynamic = 'force-dynamic'

function money(value: number | null) {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

function context(value: number | null) {
  if (value === null) return '—'
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function StatusCell({ item }: { item: CatalogListItem }) {
  if (item.status === 'missing') {
    return (
      <Badge variant="destructive">
        {item.routeTargetCount > 0
          ? `missing — ${item.routeTargetCount} target(s) still point here`
          : 'missing'}
      </Badge>
    )
  }
  if (item.origin === 'manual') return <Badge variant="outline">manual</Badge>
  return <Badge variant="secondary">available</Badge>
}

export default async function CatalogPage({
  searchParams,
}: {
  // Next 16 passes searchParams as a promise. Confirm against
  // node_modules/next/dist/docs/ before changing this signature.
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const params = await searchParams

  const providerId = typeof params.provider === 'string' ? params.provider : undefined
  const kind = typeof params.kind === 'string' ? (params.kind as ModelKind) : undefined
  const search = typeof params.q === 'string' ? params.q : undefined

  const [items, providers, settings, registry] = await Promise.all([
    listCatalog({ providerId, kind, search }),
    listProviders(),
    getCatalogSettings(),
    loadRegistry(),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Catalog</h1>
        <div className="ml-auto flex gap-2">
          <RefreshRegistryButton />
          <SyncAllButton />
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-2">
        <Input name="q" defaultValue={search ?? ''} placeholder="Search model id" className="w-64" />
        <select
          name="provider"
          defaultValue={providerId ?? ''}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          name="kind"
          defaultValue={kind ?? ''}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All kinds</option>
          {modelKinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Button type="submit" size="sm" variant="outline">Filter</Button>
      </form>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1">Model</th><th>Provider</th><th>Kind</th>
            <th>Context</th><th>In/out</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t align-top">
              <td className="py-2">
                <details>
                  <summary className="cursor-pointer font-mono text-xs">{item.modelId}</summary>
                  <div className="space-y-2 py-2">
                    <p className="text-xs text-muted-foreground">
                      {item.canonicalKey
                        ? `Matched ${item.canonicalKey}`
                        : 'No registry match — set a registry namespace on the provider, or override the fields below.'}
                    </p>
                    <OverrideForm item={item} />
                  </div>
                </details>
              </td>
              <td>{item.providerName}</td>
              <td>{item.kind}</td>
              <td>{context(item.contextWindow)}</td>
              <td>{money(item.inputPerMtok)}/{money(item.outputPerMtok)}</td>
              <td><StatusCell item={item} /></td>
              <td className="text-right">
                <form action={deleteCatalogModelAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {items.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-3 text-muted-foreground">
                Nothing here yet — sync a provider, or add a model by hand.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {providers.length > 0 ? <AddManualModelForm providers={providers} /> : null}

      <RegistrySettingsForm
        registryEnabled={settings.registryEnabled}
        registryUrl={settings.registryUrl}
        fetchedAt={registry.fetchedAt}
        status={registry.error ?? registry.status}
      />
    </div>
  )
}
