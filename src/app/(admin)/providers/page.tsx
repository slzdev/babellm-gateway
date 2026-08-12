import { Badge } from '@/components/ui/badge'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { DeleteProviderButton } from './delete-provider-button'
import { ProviderForm } from './provider-form'
import { TestProviderButton } from './test-provider-button'
import { ToggleProviderButton } from './toggle-provider-button'

export const dynamic = 'force-dynamic'

export default async function ProvidersPage() {
  await requireAdmin()
  const providers = await listProviders()

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
            <th>Status</th>
            <th>Test connection</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id} className="border-t">
              <td className="py-2 font-medium">{provider.name}</td>
              <td>{provider.adapter}</td>
              <td className="font-mono text-xs">
                {Object.entries(provider.maskedCredentials)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' ')}
              </td>
              <td>{provider.targetCount}</td>
              <td>
                <Badge variant={provider.enabled ? 'default' : 'secondary'}>
                  {provider.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </td>
              <td>
                <TestProviderButton providerId={provider.id} />
              </td>
              <td className="text-right whitespace-nowrap">
                <ToggleProviderButton id={provider.id} enabled={provider.enabled} />
                <DeleteProviderButton id={provider.id} />
              </td>
            </tr>
          ))}
          {providers.length === 0 ? (
            <tr><td colSpan={7} className="py-6 text-muted-foreground">No providers yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <ProviderForm />
    </div>
  )
}
