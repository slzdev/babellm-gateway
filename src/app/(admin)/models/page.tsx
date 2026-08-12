import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listPickerModels, targetWarnings, type TargetWarning } from '@/lib/admin/catalog'
import { listProviders } from '@/lib/admin/providers'
import { listVirtualModels } from '@/lib/admin/models'
import { requireAdmin } from '@/lib/admin/session'
import { AddTargetDialog, CreateModelDialog } from './model-form'
import { ModelSectionActions } from './model-section-actions'
import { PolicySelect } from './policy-select'
import { TargetRowActions } from './target-row-actions'

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
      <PageHeader title="Virtual models" action={<CreateModelDialog />} />

      {models.map((model) => (
        <section key={model.id} className="space-y-2 rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-medium">{model.name}</h2>
            <PolicySelect id={model.id} policy={model.policy} />
            {!model.enabled ? <Badge variant="outline">disabled</Badge> : null}
            <div className="ml-auto">
              <ModelSectionActions id={model.id} name={model.name} />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.targets.map((target) => (
                <TableRow key={target.id}>
                  <TableCell>{target.providerName}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {target.upstreamModel}
                    <TargetWarningBadge warning={warnings[target.id]} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{target.priority}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.weight}</TableCell>
                  <TableCell>
                    <Badge variant={target.enabled ? 'default' : 'secondary'}>
                      {target.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <TargetRowActions
                      target={target}
                      groups={groupsByProvider[target.providerId] ?? []}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {model.targets.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No targets — requests to this model will fail with 503.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          {providers.length > 0 ? (
            <AddTargetDialog
              virtualModelId={model.id}
              providers={providers}
              groupsByProvider={groupsByProvider}
            />
          ) : null}
        </section>
      ))}
    </div>
  )
}
