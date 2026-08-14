import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'
import { Button } from '@/components/ui/button'
import { requireAdmin } from '@/lib/admin/session'
import {
  loadDashboard, parseDashboardFilter, type DashboardSearchParams,
} from '@/lib/admin/dashboard'
import { Breakdowns } from './breakdowns'
import { DashboardFilters } from './dashboard-filters'
import { StatTiles } from './stat-tiles'
import { UsageCharts } from './usage-charts'

export const dynamic = 'force-dynamic'

function logsHref(params: DashboardSearchParams): string {
  const next = new URLSearchParams()
  // /logs has no user filter, and only values both pages share carry over:
  // 'all', '24h', '7d' and '30d' qualify. '90d' and a custom from/to have no
  // equivalent in /logs's vocabulary and are dropped, so the log viewer
  // opens at its own default (24h) in those cases — still a narrowing, but
  // forwarding a wrong-but-close range would be worse than not carrying it.
  if (params.key) next.set('key', params.key)
  if (params.model) next.set('model', params.model)
  if (params.range && ['all', '24h', '7d', '30d'].includes(params.range)) {
    next.set('range', params.range)
  }
  const query = next.toString()
  return query ? `/logs?${query}` : '/logs'
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>
}) {
  await requireAdmin()
  const params = await searchParams
  const parsed = parseDashboardFilter(params)
  const view = await loadDashboard(parsed)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Usage, cost and errors, aggregated hourly from the request log."
        action={
          <Button variant="secondary" nativeButton={false} render={<Link href={logsHref(params)} />}>
            View these requests
          </Button>
        }
      />

      {view.error ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
          <p className="font-medium">Usage statistics could not be read.</p>
          <p className="text-sm text-muted-foreground">
            Something went wrong reaching the database. This is usually transient —
            reload the page, or check the gateway&apos;s own server logs if it keeps
            happening.
          </p>
        </div>
      ) : view.storeName !== 'postgres' ? (
        <div className="space-y-2 rounded-md border px-4 py-8 text-center">
          <p className="font-medium">
            Usage statistics come from the{' '}
            <span className="font-mono">postgres</span> log store.
          </p>
          <p className="text-sm text-muted-foreground">
            Logging currently goes to <span className="font-mono">{view.storeName}</span>,
            which keeps no table for this page to aggregate. Requests are still being
            logged — there is just nothing here to count them from. Switch stores on the{' '}
            <Link className="underline" href="/settings">Settings</Link> page.
          </p>
        </div>
      ) : (
        <>
          {view.backfilledTo ? (
            <div className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
              Historical usage is still being aggregated. Totals are complete from{' '}
              <span className="font-mono">
                {view.backfilledTo.toISOString().slice(0, 16).replace('T', ' ')}
              </span>{' '}
              onward; earlier periods will fill in over the next few hours.
            </div>
          ) : null}

          <DashboardFilters keys={view.keys} users={view.users} models={view.models} />

          <StatTiles totals={view.totals} previous={view.previous} />

          {view.totals.requests === 0 ? (
            <div className="space-y-2 rounded-md border px-4 py-8 text-center">
              <p className="font-medium">No usage in this period.</p>
              <p className="text-sm text-muted-foreground">
                Requests are aggregated once a minute, so the most recent few may not
                be counted yet. Widen the range, or send a request and check{' '}
                <Link className="underline" href="/logs">Request logs</Link>.
              </p>
            </div>
          ) : (
            <>
              <UsageCharts series={view.series} grain={parsed.grain} />
              <Breakdowns breakdowns={view.breakdowns} />
            </>
          )}
        </>
      )}
    </div>
  )
}
