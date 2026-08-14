import { Card, CardContent } from '@/components/ui/card'
import { formatCost, formatCount, formatDelta, formatPointsDelta } from '@/lib/admin/format'
import type { UsageTotals } from '@/lib/stats/types'

function Tile({
  label, value, delta, note,
}: {
  label: string
  value: string
  delta?: string | null
  note?: string | null
}) {
  // Both, not one or the other. A deployment with a single uncatalogued model
  // carries its "N unpriced" note permanently, and making the note replace
  // the delta would mean such a deployment never sees a cost trend at all —
  // its steady state, not an edge case. The note comes first because it
  // qualifies the number above it; the delta follows because it is still true.
  const footnote = [note, delta ? `${delta} vs previous period` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {/* The non-breaking space holds the line's height on a tile that has
            neither, so the tiles stay the same size. */}
        <div className="text-xs text-muted-foreground">{footnote || ' '}</div>
      </CardContent>
    </Card>
  )
}

export function StatTiles({
  totals,
  previous,
}: {
  totals: UsageTotals
  previous: UsageTotals | null
}) {
  const errorRate = totals.requests === 0
    ? null
    : `${((totals.errorRequests / totals.requests) * 100).toFixed(1)}%`

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Tile
        label="Requests"
        value={formatCount(totals.requests)}
        delta={formatDelta(totals.requests, previous?.requests ?? null)}
      />
      <Tile
        label="Cost"
        value={formatCost(totals.costUsd)}
        delta={formatDelta(Number(totals.costUsd), previous ? Number(previous.costUsd) : null)}
        // A total that excludes requests the catalog could not price is not
        // the whole story, and saying so is the entire reason the column
        // exists. The logs page makes the same refusal per row.
        note={totals.unpricedRequests > 0
          ? `${formatCount(totals.unpricedRequests)} unpriced`
          : null}
      />
      <Tile
        label="Tokens in / out"
        value={`${formatCount(totals.promptTokens)} / ${formatCount(totals.completionTokens)}`}
      />
      <Tile
        label="Error rate"
        value={errorRate ?? '—'}
        // Percentage points, from the unrounded rates: this is the one tile
        // whose value is itself a percentage, and a percent change of a
        // percentage misreads small movements as large ones.
        delta={previous && previous.requests > 0 && totals.requests > 0
          ? formatPointsDelta(
              totals.errorRequests / totals.requests,
              previous.errorRequests / previous.requests,
            )
          : null}
      />
      <Tile
        label="Avg latency"
        value={totals.avgLatencyMs === null ? '—' : `${Math.round(totals.avgLatencyMs)} ms`}
        note={totals.avgTtftMs === null
          ? null
          : `${Math.round(totals.avgTtftMs)} ms to first token`}
      />
    </div>
  )
}
