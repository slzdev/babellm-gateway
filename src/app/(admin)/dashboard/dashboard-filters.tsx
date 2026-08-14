'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { DEFAULT_DASHBOARD_RANGE, nextDashboardParams } from '@/lib/admin/dashboard-params'

const RANGES = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

export function DashboardFilters({
  keys,
  users,
  models,
}: {
  keys: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string }>
  models: string[]
}) {
  const router = useRouter()
  const params = useSearchParams()

  function apply(name: string, value: string) {
    router.push(`/dashboard?${nextDashboardParams(params, name, value).toString()}`)
  }

  const custom = params.get('from') || params.get('to')

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        // A custom range is in force, so no preset is selected — showing one
        // would claim a window the page is not displaying.
        value={custom ? '' : params.get('range') ?? DEFAULT_DASHBOARD_RANGE}
        onValueChange={(v) => { if (v) apply('range', v) }}
      >
        <SelectTrigger className="w-40"><SelectValue placeholder="Custom range" /></SelectTrigger>
        <SelectContent>
          {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <Input
        type="date"
        aria-label="From date"
        className="w-40"
        value={params.get('from') ?? ''}
        onChange={(event) => apply('from', event.target.value)}
      />
      <Input
        type="date"
        aria-label="To date"
        className="w-40"
        value={params.get('to') ?? ''}
        onChange={(event) => apply('to', event.target.value)}
      />

      <Select value={params.get('key') ?? 'all'} onValueChange={(v) => { if (v) apply('key', v) }}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Any key" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any key</SelectItem>
          {keys.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('user') ?? 'all'} onValueChange={(v) => { if (v) apply('user', v) }}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Any user" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any user</SelectItem>
          {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={params.get('model') ?? 'all'} onValueChange={(v) => { if (v) apply('model', v) }}>
        <SelectTrigger className="w-52"><SelectValue placeholder="Any model" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any model</SelectItem>
          {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}
