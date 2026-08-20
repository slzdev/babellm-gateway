import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeftIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { loadLogDetail } from '@/lib/admin/logs'
import { requireAdmin } from '@/lib/admin/session'

export const dynamic = 'force-dynamic'

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}

function money(value: string | null) {
  return value === null ? 'unpriced' : `$${Number(value).toFixed(9)}`
}

/**
 * capPayload stores one of two truncation envelopes under the same
 * `truncated: true` flag: an oversized payload (a real preview, clipped to
 * the byte cap) and an unserializable one (a cyclic or otherwise
 * un-JSON-able value, stored as nothing at all). They need different
 * explanations — "exceeded the configured size cap" is simply false for the
 * second case.
 */
function truncationNote(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const envelope = value as { truncated?: unknown; error?: unknown }
  if (envelope.truncated !== true) return null
  return envelope.error === 'unserializable'
    ? 'This value could not be serialized to JSON and was not stored.'
    : 'This payload exceeded the configured size cap and was stored as a truncated preview.'
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="w-full px-4 py-3 text-left text-sm font-medium">
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-96 overflow-auto border-t px-4 py-3 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export default async function LogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAdmin()
  const { id } = await params
  const log = await loadLogDetail(decodeURIComponent(id))
  if (!log) notFound()

  // `payload.truncated` has three sources, only two of which stamp an
  // envelope on the value itself (capPayload replacing an oversized or
  // unserializable stored request/response). The third — a streaming
  // response whose assistant text hit the byte cap mid-relay
  // (chat-handler.ts's `truncatedUpstream`) — stores an ordinary,
  // envelope-free completion object. When neither field carries a
  // recognizable envelope but the payload is still marked truncated, that
  // third source is the only thing it can be.
  const requestTruncationNote = log.payload ? truncationNote(log.payload.request) : null
  const responseTruncationNote = log.payload ? truncationNote(log.payload.response) : null
  const streamClippedSilently = Boolean(
    log.payload?.truncated && !requestTruncationNote && !responseTruncationNote,
  )

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/logs"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Request logs
        </Link>

        <PageHeader
          title={log.id}
          description={`${log.createdAt.toISOString().replace('T', ' ').slice(0, 19)} · ${log.model ?? 'unknown model'}`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
        <Field
          label="Status"
          value={
            <span className="flex items-center gap-2">
              <Badge variant={log.status >= 500 ? 'destructive' : log.status >= 400 ? 'secondary' : 'default'}>
                {log.status}
              </Badge>
              <span className="text-muted-foreground">{log.outcome}</span>
            </span>
          }
        />
        <Field label="Key" value={log.keyName ?? '—'} />
        <Field label="Served by" value={log.finalProvider ? `${log.finalProvider} · ${log.finalUpstreamModel}` : '—'} />
        <Field label="Streaming" value={log.stream ? 'yes' : 'no'} />
        <Field label="Latency" value={`${log.latencyMs} ms`} />
        <Field label="Time to first token" value={log.ttftMs === null ? '—' : `${log.ttftMs} ms`} />
        <Field
          label="Tokens"
          value={
            log.promptTokens === null && log.completionTokens === null
              ? 'not reported'
              : `${log.promptTokens ?? '—'} in / ${log.completionTokens ?? '—'} out` +
                (log.cachedTokens ? ` · ${log.cachedTokens} cached` : '') +
                (log.reasoningTokens ? ` · ${log.reasoningTokens} reasoning` : '')
          }
        />
        <Field label="Total cost" value={money(log.costUsd)} />
      </div>

      {log.errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <div className="font-medium">{log.errorType}{log.errorCode ? ` · ${log.errorCode}` : ''}</div>
          <div className="text-muted-foreground">{log.errorMessage}</div>
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Attempts</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Upstream model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.attempts.map((attempt) => (
              <TableRow key={attempt.n}>
                <TableCell>{attempt.n}</TableCell>
                <TableCell>{attempt.provider}</TableCell>
                <TableCell className="font-mono text-xs">{attempt.model}</TableCell>
                <TableCell>{attempt.status}</TableCell>
                <TableCell className="text-right tabular-nums">{attempt.latencyMs} ms</TableCell>
                <TableCell className="text-xs text-muted-foreground">{attempt.error ?? '—'}</TableCell>
              </TableRow>
            ))}
            {log.attempts.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  The request failed before any target was tried.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Cost breakdown</h2>
        <div className="grid grid-cols-2 gap-4 rounded-md border p-4 md:grid-cols-4">
          <Field label="Input" value={money(log.inputCostUsd)} />
          <Field label="Cached input" value={money(log.cachedCostUsd)} />
          <Field label="Output" value={money(log.outputCostUsd)} />
          <Field label="Total" value={money(log.costUsd)} />
        </div>
        {log.pricing ? (
          <p className="text-xs text-muted-foreground">
            Rates used, per million tokens: input {log.pricing.inputPerMtok ?? '—'}, cached{' '}
            {log.pricing.cachedInputPerMtok ?? 'same as input'}, output{' '}
            {log.pricing.outputPerMtok ?? '—'}. Snapshotted at request time, so later
            catalog edits do not change this row.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The catalog had no price for this provider and model, so this request is
            unpriced rather than free.
          </p>
        )}
      </section>

      {log.tags ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Tags</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(log.tags).map(([key, value]) => (
              <Badge key={key} variant="secondary" className="font-mono">
                {key}={value}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      {log.droppedParams?.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Dropped parameters</h2>
          <p className="text-sm text-muted-foreground">
            The winning target&apos;s protocol could not express: {log.droppedParams.join(', ')}.
          </p>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Payloads</h2>
        {log.payload ? (
          <div className="space-y-2">
            <Json label="Request" value={log.payload.request} />
            {requestTruncationNote ? (
              <p className="text-xs text-muted-foreground">{requestTruncationNote}</p>
            ) : null}
            <Json label="Response" value={log.payload.response} />
            {responseTruncationNote ? (
              <p className="text-xs text-muted-foreground">{responseTruncationNote}</p>
            ) : null}
            {streamClippedSilently ? (
              <p className="text-xs text-muted-foreground">
                This response was still streaming to the client when the assistant text hit
                the configured size cap, so the captured copy above stops mid-stream. That is
                distinct from a stored payload being replaced with a preview — nothing here
                was clipped after the fact.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {log.payloadCaptured
              ? 'This request was marked as captured, but no payload was stored with it.'
              : 'Payload capture is off for this API key. Turn it on per key on the API keys page.'}
          </p>
        )}
      </section>
    </div>
  )
}
