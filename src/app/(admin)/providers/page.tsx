import { Badge } from '@/components/ui/badge'
import { listProviders, type ProviderListItem } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { listRegistryNamespaces } from '@/lib/catalog/namespaces'
import { DeleteProviderButton } from './delete-provider-button'
import { EditProviderForm } from './edit-provider-form'
import { ProviderForm } from './provider-form'
import { RegistryNamespaceDatalist } from './registry-namespace-field'
import { SyncProviderButton } from './sync-provider-button'
import { TestProviderButton } from './test-provider-button'
import { ToggleProviderButton } from './toggle-provider-button'

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
        ⚠ 0 of {total} matched models.dev — set a registry namespace to get pricing
        and context limits
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
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Providers</h1>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Name</th>
            <th>Adapter</th>
            <th>Credentials</th>
            <th>Targets</th>
            <th>Models</th>
            <th>Status</th>
            <th>Test connection</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id} className="border-t align-top">
              <td className="py-2 font-medium">
                {provider.name}
                <EditProviderForm provider={provider} />
              </td>
              <td>{provider.adapter}</td>
              <td className="font-mono text-xs">
                {Object.entries(provider.maskedCredentials)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' ')}
              </td>
              <td>{provider.targetCount}</td>
              <td>
                <a href={`/catalog?provider=${provider.id}`} className="underline">
                  {provider.catalogModelCount}
                </a>
                <div className="text-xs text-muted-foreground">
                  <SyncStatus provider={provider} />
                </div>
              </td>
              <td>
                <Badge variant={provider.enabled ? 'default' : 'secondary'}>
                  {provider.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </td>
              <td>
                <TestProviderButton providerId={provider.id} />
              </td>
              <td className="text-right whitespace-nowrap">
                <SyncProviderButton id={provider.id} />
                <ToggleProviderButton id={provider.id} enabled={provider.enabled} />
                <DeleteProviderButton id={provider.id} />
              </td>
            </tr>
          ))}
          {providers.length === 0 ? (
            <tr><td colSpan={8} className="py-6 text-muted-foreground">No providers yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <RegistryNamespaceDatalist namespaces={namespaces} />
      <ProviderForm />
    </div>
  )
}
