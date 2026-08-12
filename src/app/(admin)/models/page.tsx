import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listPickerModels, targetWarnings, type TargetWarning } from '@/lib/admin/catalog'
import { listProviders } from '@/lib/admin/providers'
import { listVirtualModels } from '@/lib/admin/models'
import { requireAdmin } from '@/lib/admin/session'
import { deleteModelAction, removeTargetAction } from './actions'
import { EditTargetForm } from './edit-target-form'
import { AddTargetForm, CreateModelForm } from './model-form'
import { PolicySelect } from './policy-select'
import { TargetEnabledToggle } from './target-enabled-toggle'

export const dynamic = 'force-dynamic'

function TargetWarningBadge({ warning }: { warning: TargetWarning | undefined }) {
  if (!warning) return null
  if (warning === 'never_synced') {
    return <Badge variant="outline" className="ml-2">provider not synced yet</Badge>
  }
  if (warning === 'missing') {
    return <Badge variant="destructive" className="ml-2">retired upstream</Badge>
  }
  return <Badge variant="destructive" className="ml-2">not in catalog</Badge>
}

export default async function ModelsPage() {
  await requireAdmin()
  const [models, providers, warnings] = await Promise.all([
    listVirtualModels(), listProviders(), targetWarnings(),
  ])

  const groupsByProvider = Object.fromEntries(
    await Promise.all(
      providers.map(async (provider) => [provider.id, await listPickerModels(provider.id)] as const),
    ),
  )

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Virtual models</h1>

      {models.map((model) => (
        <section key={model.id} className="space-y-2 rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-medium">{model.name}</h2>
            <PolicySelect id={model.id} policy={model.policy} />
            {!model.enabled ? <Badge variant="outline">disabled</Badge> : null}
            <form action={deleteModelAction} className="ml-auto">
              <input type="hidden" name="id" value={model.id} />
              <Button type="submit" variant="ghost" size="sm">Delete</Button>
            </form>
          </div>

          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Provider</th><th>Upstream model</th><th>Priority</th>
                <th>Weight</th><th>Enabled</th><th /><th />
              </tr>
            </thead>
            <tbody>
              {model.targets.map((target) => (
                <tr key={target.id} className="border-t">
                  <td className="py-1">{target.providerName}</td>
                  <td className="font-mono text-xs">
                    {target.upstreamModel}
                    <TargetWarningBadge warning={warnings[target.id]} />
                    <EditTargetForm
                      target={target}
                      groups={groupsByProvider[target.providerId] ?? []}
                    />
                  </td>
                  <td>{target.priority}</td>
                  <td>{target.weight}</td>
                  <td>
                    <Badge variant={target.enabled ? 'default' : 'secondary'}>
                      {target.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </td>
                  <td className="text-right">
                    <TargetEnabledToggle id={target.id} enabled={target.enabled} />
                  </td>
                  <td className="text-right">
                    <form action={removeTargetAction}>
                      <input type="hidden" name="id" value={target.id} />
                      <Button type="submit" variant="ghost" size="sm">Remove</Button>
                    </form>
                  </td>
                </tr>
              ))}
              {model.targets.length === 0 ? (
                <tr><td colSpan={7} className="py-3 text-muted-foreground">No targets — requests to this model will fail with 503.</td></tr>
              ) : null}
            </tbody>
          </table>

          {providers.length > 0 ? (
            <AddTargetForm
              virtualModelId={model.id}
              providers={providers}
              groupsByProvider={groupsByProvider}
            />
          ) : null}
        </section>
      ))}

      <CreateModelForm />
    </div>
  )
}
