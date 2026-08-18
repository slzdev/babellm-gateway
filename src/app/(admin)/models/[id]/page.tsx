import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeftIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import {
  listPickerModels, targetGatewayViews, targetWarnings, type TargetWarning,
} from '@/lib/admin/catalog'
import { targetBreakerViews, type TargetBreakerView } from '@/lib/admin/health'
import { getVirtualModel } from '@/lib/admin/models'
import { listProviders } from '@/lib/admin/providers'
import { requireAdmin } from '@/lib/admin/session'
import { resolveRoutingSettings } from '@/lib/routing-settings'
import { API_FLAVOR_LABELS } from '@/lib/api-flavors'
import { AddTargetDialog } from '../model-form'
import { ModelSectionActions } from '../model-section-actions'
import { TargetRowActions } from '../target-row-actions'
import { SettingsForm } from './settings-form'

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

function BreakerBadge({ view }: { view: TargetBreakerView | undefined }) {
  // A healthy target renders nothing at all: the normal case is every row
  // healthy, and a column of "closed" badges is noise that hides the one row
  // that matters.
  if (!view || view.state === 'closed') return null
  if (view.state === 'open') {
    return (
      <Badge variant="destructive" title={view.lastError ?? undefined}>
        open{view.reopensIn === null ? '' : ` · ${view.reopensIn}s`}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" title={view.lastError ?? undefined}>half-open</Badge>
  )
}

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAdmin()
  const { id } = await params

  const model = await getVirtualModel(id)
  if (!model) notFound()

  const [providers, warnings, gatewayViews, breakers, routingSettings] = await Promise.all([
    listProviders(),
    targetWarnings(),
    targetGatewayViews(),
    targetBreakerViews(model.targets),
    resolveRoutingSettings(),
  ])
  const groupsByProvider = Object.fromEntries(
    await Promise.all(
      providers.map(async (provider) => [provider.id, await listPickerModels(provider.id)] as const),
    ),
  )

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/models"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Virtual models
        </Link>

        <PageHeader
          title={model.name}
          description={model.description ?? undefined}
          action={<ModelSectionActions id={model.id} name={model.name} />}
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Settings</CardTitle>
          <CardDescription>How this model behaves when a request comes in.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm model={model} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Route targets</CardTitle>
          <CardDescription>
            The upstream models this one routes to. Targets sharing a priority
            are tried together, in the order the policy sets; lower priorities
            are tried first.
          </CardDescription>
          {providers.length > 0 ? (
            <CardAction>
              <AddTargetDialog
                virtualModelId={model.id}
                providers={providers}
                groupsByProvider={groupsByProvider}
                globalThreshold={routingSettings.threshold}
                globalCooldown={routingSettings.cooldownSeconds}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Provider</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Service tier</TableHead>
                <TableHead>API flavor</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="w-0"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.targets.map((target) => (
                <TableRow key={target.id}>
                  <TableCell className="pl-4">{target.providerName}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {target.upstreamModel}
                    <TargetWarningBadge warning={warnings[target.id]} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{target.priority}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.weight}</TableCell>
                  <TableCell>
                    {target.serviceTier
                      ? <Badge variant="outline">{target.serviceTier}</Badge>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {API_FLAVOR_LABELS[gatewayViews[target.id]?.flavor ?? 'chat_completions']}
                    </Badge>
                    <span className="ml-2 text-xs text-muted-foreground">
                      from {gatewayViews[target.id]?.source ?? 'provider'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={target.enabled ? 'default' : 'secondary'}>
                      {target.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell><BreakerBadge view={breakers.get(target.id)} /></TableCell>
                  <TableCell className="pr-4 text-right">
                    <TargetRowActions
                      target={target}
                      virtualModelId={model.id}
                      groups={groupsByProvider[target.providerId] ?? []}
                      breakerState={breakers.get(target.id)?.state ?? 'closed'}
                      globalThreshold={routingSettings.threshold}
                      globalCooldown={routingSettings.cooldownSeconds}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {model.targets.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    No targets — requests to this model will fail with 503.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
