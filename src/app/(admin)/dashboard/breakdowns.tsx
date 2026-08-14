'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { formatCost, formatCount } from '@/lib/admin/format'
import { BREAKDOWN_ROW_LIMIT } from '@/lib/stats/types'
import type { BreakdownDimension, BreakdownRow } from '@/lib/stats/types'

const TABS: Array<{ value: BreakdownDimension; label: string }> = [
  { value: 'model', label: 'By model' },
  { value: 'key', label: 'By key' },
  { value: 'user', label: 'By user' },
  { value: 'provider', label: 'By provider' },
]

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.id ?? 'none'}-${row.label}`}>
              <TableCell className="font-mono text-xs">{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.requests)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {row.errorRequests === 0 ? '—' : formatCount(row.errorRequests)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatCount(row.tokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCost(row.costUsd)}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                Nothing in this period.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {/* A full table is the one case where the reader cannot tell whether
          they are looking at everything, and the tiles above count rows this
          list may not show. Saying so is cheaper than being wrong about it. */}
      {rows.length === BREAKDOWN_ROW_LIMIT ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          Only the top {BREAKDOWN_ROW_LIMIT} rows by cost are listed. The totals above
          count everything in the period.
        </p>
      ) : null}
    </>
  )
}

export function Breakdowns({
  breakdowns,
}: {
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>
}) {
  return (
    <Tabs defaultValue="model">
      <TabsList>
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          <BreakdownTable rows={breakdowns[tab.value]} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
