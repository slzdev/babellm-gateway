import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listCatalog, type CatalogListItem } from '@/lib/admin/catalog'
import { listVirtualModels } from '@/lib/admin/models'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { getCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { modelKinds, type ModelKind } from '@/lib/catalog/types'
import { AddManualModelDialog, RegistrySettingsForm } from './catalog-forms'
import { CatalogRowActions } from './catalog-row-actions'
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
  // A URL can carry anything; an unrecognised ?kind= is treated as no filter
  // rather than passed through to the query.
  const kind = typeof params.kind === 'string' && (modelKinds as readonly string[]).includes(params.kind)
    ? (params.kind as ModelKind)
    : undefined
  const search = typeof params.q === 'string' ? params.q : undefined

  const [items, providers, settings, registry, virtualModels] = await Promise.all([
    listCatalog({ providerId, kind, search }),
    listProviders(),
    getCatalogSettings(),
    // Read-only: this page must never trigger the live models.dev fetch. That
    // only happens from a sync or the explicit "Refresh registry" action.
    loadRegistry({ readOnly: true }),
    listVirtualModels(),
  ])

  const virtualModelOptions = virtualModels.map((m) => ({ id: m.id, name: m.name }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalog"
        action={
          <>
            <RefreshRegistryButton />
            <SyncAllButton />
            {providers.length > 0 ? <AddManualModelDialog providers={providers} /> : null}
          </>
        }
      />

      <form className="flex flex-wrap items-end gap-2">
        <Input
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search model id"
          aria-label="Search model id"
          className="w-64"
        />
        <select
          name="provider"
          defaultValue={providerId ?? ''}
          aria-label="Filter by provider"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          name="kind"
          defaultValue={kind ?? ''}
          aria-label="Filter by kind"
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">All kinds</option>
          {modelKinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Button type="submit" size="sm" variant="outline">Filter</Button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Context</TableHead>
            <TableHead className="text-right">In/out</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id} className="align-top">
              <TableCell><span className="font-mono text-xs">{item.modelId}</span></TableCell>
              <TableCell>{item.providerName}</TableCell>
              <TableCell>{item.kind}</TableCell>
              <TableCell className="text-right tabular-nums">{context(item.contextWindow)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(item.inputPerMtok)}/{money(item.outputPerMtok)}
              </TableCell>
              <TableCell><StatusCell item={item} /></TableCell>
              <TableCell className="text-right">
                <CatalogRowActions item={item} virtualModels={virtualModelOptions} />
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                Nothing here yet — sync a provider, or add a model by hand.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <RegistrySettingsForm
        registryEnabled={settings.registryEnabled}
        registryUrl={settings.registryUrl}
        fetchedAt={registry.fetchedAt}
        status={registry.error ?? registry.status}
      />
    </div>
  )
}
