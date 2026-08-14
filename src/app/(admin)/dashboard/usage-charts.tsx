'use client'

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { formatCost, formatCount } from '@/lib/admin/format'
import type { Grain } from '@/lib/stats/buckets'
import type { UsagePoint } from '@/lib/stats/types'

/** Errors sit on top of the healthy mass, so the bottom of each bar is the
 * traffic that worked and the cap is what did not.
 *
 * The `--chart-*` tokens are chroma-0 (pure gray), so the three classes are
 * distinguished by lightness alone. chart-3 (L 0.439) against chart-5
 * (L 0.269) is the widest gap available among the existing tokens — wider
 * than chart-4 (L 0.371) would give — so it's the pick here even though it
 * still falls short of a 3:1 contrast ratio. The stroke on each <Bar> below
 * is what separates the segments; lightness alone does not. */
const REQUEST_CONFIG = {
  success: { label: 'Success', color: 'var(--chart-1)' },
  clientError: { label: 'Client error', color: 'var(--chart-3)' },
  serverError: { label: 'Server error', color: 'var(--chart-5)' },
} satisfies ChartConfig

const COST_CONFIG = {
  cost: { label: 'Cost', color: 'var(--chart-2)' },
} satisfies ChartConfig

function tickFormatter(grain: Grain) {
  return (value: string) => {
    const date = new Date(value)
    if (grain === 'hour') {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
      })
    }
    if (grain === 'day') {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
}

export function UsageCharts({ series, grain }: { series: UsagePoint[]; grain: Grain }) {
  // The page's own empty state covers this; two blank axes would say less.
  if (series.length === 0) return null

  const data = series.map((point) => ({
    bucket: point.bucket.toISOString(),
    success: point.success,
    clientError: point.clientError,
    serverError: point.serverError,
    // Strings everywhere else on purpose — numeric(18,9) must not be parsed
    // into a float on the way through the database layer. A chart cannot
    // plot a string, so the conversion happens here and nowhere earlier.
    cost: Number(point.costUsd),
  }))

  const formatTick = tickFormatter(grain)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-sm font-medium">Requests</div>
          {/* Its own scroll container: a wide series must never make the page
              body scroll sideways. */}
          <div className="overflow-x-auto">
            <ChartContainer config={REQUEST_CONFIG} className="h-64 w-full min-w-80">
              <BarChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8}
                  minTickGap={24} tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false} axisLine={false} width={48}
                  tickFormatter={(v: number) => formatCount(v)}
                />
                <ChartTooltip
                  content={<ChartTooltipContent labelFormatter={(_, p) =>
                    formatTick(String(p[0]?.payload?.bucket))} />}
                />
                <ChartLegend content={<ChartLegendContent />} />
                {/* A hairline of page background between the segments. The
                    tokens above are chroma-0, so adjacent segments sit around
                    1.9:1 against each other and a stack reads as one block
                    without it. A separator does the work the palette cannot,
                    and it does it without changing the palette — whether the
                    error series should carry the destructive hue is a design
                    decision, not a contrast fix. */}
                <Bar
                  dataKey="success" stackId="r" fill="var(--color-success)"
                  stroke="var(--background)" strokeWidth={1}
                />
                <Bar
                  dataKey="clientError" stackId="r" fill="var(--color-clientError)"
                  stroke="var(--background)" strokeWidth={1}
                />
                <Bar
                  dataKey="serverError" stackId="r" fill="var(--color-serverError)"
                  stroke="var(--background)" strokeWidth={1} radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-sm font-medium">Cost</div>
          <div className="overflow-x-auto">
            <ChartContainer config={COST_CONFIG} className="h-64 w-full min-w-80">
              <AreaChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8}
                  minTickGap={24} tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false} axisLine={false} width={64}
                  // The same formatter the tiles use, so the axis and the
                  // headline number cannot disagree about what a cost is.
                  tickFormatter={(v: number) => formatCost(String(v))}
                />
                <ChartTooltip
                  content={<ChartTooltipContent
                    labelFormatter={(_, p) => formatTick(String(p[0]?.payload?.bucket))}
                    formatter={(value) => formatCost(String(value))}
                  />}
                />
                <Area
                  dataKey="cost" type="monotone" stroke="var(--color-cost)"
                  fill="var(--color-cost)" fillOpacity={0.2}
                />
              </AreaChart>
            </ChartContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
