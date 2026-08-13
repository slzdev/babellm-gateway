import Link from 'next/link'
import { asc } from 'drizzle-orm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { db } from '@/lib/db'
import { virtualModels } from '@/lib/db/schema'
import { listApiKeys } from '@/lib/admin/keys'
import { loadLogs, parseLogFilter, type LogSearchParams } from '@/lib/admin/logs'
import { requireAdmin } from '@/lib/admin/session'
import { LogFilters } from './log-filters'

export const dynamic = 'force-dynamic'

function statusVariant(status: number) {
  if (status >= 500) return 'destructive' as const
  if (status >= 400) return 'secondary' as const
  return 'default' as const
}

function cost(value: string | null) {
  // A null cost is not a free request — it is a request the catalog could not
  // price. Saying "unpriced" is the whole reason the column is nullable.
  //
  // Full nine-decimal precision, matching the detail page: the column is
  // numeric(18,9) specifically so sub-micro-dollar requests keep a value
  // instead of rounding to a lying $0.000000, and this page must agree with
  // the detail page on what a given row costs.
  return value === null ? 'unpriced' : `$${Number(value).toFixed(9)}`
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<LogSearchParams>
}) {
  await requireAdmin()
  const params = await searchParams
  const filter = parseLogFilter(params)

  const [view, keys, models] = await Promise.all([
    loadLogs(filter),
    listApiKeys(),
    db.select({ name: virtualModels.name }).from(virtualModels).orderBy(asc(virtualModels.name)),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Request logs"
        description="Every request the gateway has served, from the configured log store."
      />

      {view.fallback === 'unknown_driver' ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          No log driver named <span className="font-mono">{view.configured}</span> is
          registered in this build, so logging has fallen back to stdout. Pick a
          driver on the <Link className="underline" href="/settings">Settings</Link> page.
        </div>
      ) : null}

      {view.storeName === 'postgres' ? (
        <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Logs are stored in this gateway&apos;s own PostgreSQL database. That is the
          right choice for development and low traffic, but at high request rates this
          table and its indexes will compete with the queries that serve requests.
          Switch stores on the <Link className="underline" href="/settings">Settings</Link> page
          before that day arrives.
        </div>
      ) : null}

      {view.error ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
          <p className="font-medium">The log store could not be read.</p>
          <p className="text-sm text-muted-foreground">
            Something went wrong reaching the configured log store. This is usually
            transient — reload the page, or check the gateway&apos;s own server logs if it
            keeps happening.
          </p>
        </div>
      ) : !view.readable ? (
        <div className="space-y-2 rounded-md border px-4 py-8 text-center">
          <p className="font-medium">
            The <span className="font-mono">{view.storeName}</span> store cannot be read back.
          </p>
          <p className="text-sm text-muted-foreground">
            Requests are still being logged — one JSON line per request, on the
            container&apos;s stdout. Read them with{' '}
            <span className="font-mono">docker compose logs -f gateway</span> and search by
            the <span className="font-mono">x-request-id</span> header the gateway returns.
          </p>
        </div>
      ) : (
        <>
          <LogFilters keys={keys} models={models.map((m) => m.name)} />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.page?.rows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer">
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/logs/${row.id}`} className="hover:underline">
                      {row.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                    </Link>
                  </TableCell>
                  <TableCell>{row.keyName ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{row.model ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{row.finalProvider ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    {row.outcome === 'ok' ? null : (
                      <span className="ml-2 text-xs text-muted-foreground">{row.outcome}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.latencyMs} ms</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {/* Each side renders independently: a null count means it
                        was not measured, not that it was zero — the same
                        distinction the "unpriced" cost cell protects. */}
                    {row.promptTokens === null && row.completionTokens === null
                      ? '—'
                      : `${row.promptTokens ?? '—'} / ${row.completionTokens ?? '—'}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cost(row.costUsd)}</TableCell>
                </TableRow>
              ))}
              {view.page && view.page.rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    No requests match these filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="flex justify-end gap-2">
            {/* Rendered as a link only when a cursor exists — Base UI's disabled
                prop only suppresses a native <button>, so an unusable page
                still needs to fall back to a plain disabled button rather
                than a Link that would silently navigate. */}
            {view.page?.prevCursor ? (
              <Button
                variant="secondary"
                nativeButton={false}
                render={<Link href={`/logs?${cursorParams(params, 'before', view.page.prevCursor)}`} />}
              >
                Newer
              </Button>
            ) : (
              <Button variant="secondary" disabled>Newer</Button>
            )}
            {view.page?.nextCursor ? (
              <Button
                variant="secondary"
                nativeButton={false}
                render={<Link href={`/logs?${cursorParams(params, 'after', view.page.nextCursor)}`} />}
              >
                Older
              </Button>
            ) : (
              <Button variant="secondary" disabled>Older</Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Keeps the active filters and swaps only the cursor, so paging does not
 * silently widen the query. */
function cursorParams(
  params: LogSearchParams,
  name: 'after' | 'before',
  cursor: string | null | undefined,
): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== 'after' && key !== 'before') next.set(key, value)
  }
  if (cursor) next.set(name, cursor)
  return next.toString()
}
