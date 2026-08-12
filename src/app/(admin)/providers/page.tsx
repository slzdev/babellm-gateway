import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listProviders, type ProviderListItem } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { listRegistryNamespaces } from '@/lib/catalog/namespaces'
import { CreateProviderDialog } from './provider-form'
import { ProviderRowActions } from './provider-row-actions'
import { RegistryNamespaceProvider } from './registry-namespace-field'

export const dynamic = 'force-dynamic'

/**
 * A summary written before match counting existed carries no count, and must
 * not be reported as zero matches — so an absent count renders nothing.
 */
function RegistryMatch({ matched, total }: { matched?: number; total: number }) {
  if (matched === undefined || total === 0 || matched === total) return null

  if (matched === 0) {
    return (
      <div className="text-destructive">
        ⚠ 0 of {total} matched models.dev — no pricing or context limits; check this
        provider&apos;s registry namespace
      </div>
    )
  }

  return <div>{matched} of {total} matched models.dev</div>
}

function SyncStatus({ provider }: { provider: ProviderListItem }) {
  if (!provider.lastSyncedAt) return <>never synced</>

  const when = provider.lastSyncedAt.toISOString()
  if (provider.lastSyncStatus === 'ok' && provider.lastSyncSummary) {
    const { added, updated, missing, matched, total } = provider.lastSyncSummary
    return (
      <>
        synced {when} · +{added} new ~{updated} updated{missing > 0 ? ` !${missing} missing` : ''}
        <RegistryMatch matched={matched} total={total} />
      </>
    )
  }
  if (provider.lastSyncStatus === 'unsupported') {
    // Not an error: gemini and bedrock have no listModels adapter until
    // Phase 3, so every sync reports unsupported. Inherits the row's muted
    // text color instead of the destructive one.
    return <>{provider.lastSyncError ?? 'model discovery not supported'}</>
  }
  return <span className="text-destructive">{provider.lastSyncStatus}: {provider.lastSyncError}</span>
}

export default async function ProvidersPage() {
  await requireAdmin()
  const [providers, namespaces] = await Promise.all([
    listProviders(),
    listRegistryNamespaces(),
  ])

  return (
    // Both dialogs draw a namespace field, so the provider wraps the whole page
    // rather than the table alone.
    <RegistryNamespaceProvider namespaces={namespaces}>
      <div className="space-y-6">
        <PageHeader title="Providers" action={<CreateProviderDialog />} />

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Adapter</TableHead>
              <TableHead>Credentials</TableHead>
              <TableHead className="text-right">Targets</TableHead>
              <TableHead>Models</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((provider) => (
              <TableRow key={provider.id} className="align-top">
                <TableCell className="font-medium">{provider.name}</TableCell>
                <TableCell className="text-muted-foreground">{provider.adapter}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {Object.entries(provider.maskedCredentials)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' ')}
                </TableCell>
                <TableCell className="text-right tabular-nums">{provider.targetCount}</TableCell>
                <TableCell className="whitespace-normal">
                  <a href={`/catalog?provider=${provider.id}`} className="underline">
                    {provider.catalogModelCount}
                  </a>
                  <div className="text-xs text-muted-foreground">
                    <SyncStatus provider={provider} />
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={provider.enabled ? 'default' : 'secondary'}>
                    {provider.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <ProviderRowActions provider={provider} />
                </TableCell>
              </TableRow>
            ))}
            {providers.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No providers yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </RegistryNamespaceProvider>
  )
}
