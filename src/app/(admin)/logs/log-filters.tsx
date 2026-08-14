'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DEFAULT_LOG_PAGE_SIZE, LOG_PAGE_SIZES, nextFilterParams,
} from '@/lib/admin/log-filter-params'

const RANGES = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
]

const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: 'success', label: 'Success' },
  { value: 'client_error', label: 'Client error' },
  { value: 'server_error', label: 'Server error' },
  { value: 'stream_interrupted', label: 'Stream interrupted' },
  { value: 'client_closed', label: 'Client closed' },
]

/**
 * Rows per page. Sits with the pager rather than in the filter bar — it
 * changes how much of the result set a page shows, not which requests are in
 * it — but it goes through `nextFilterParams` like every filter, because the
 * keyset cursor in the URL describes a page of the old size and means
 * nothing once the size changes.
 */
export function PageSizeSelect() {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Rows per page</span>
      <Select
        value={params.get('size') ?? String(DEFAULT_LOG_PAGE_SIZE)}
        onValueChange={(v) => {
          if (v) router.push(`/logs?${nextFilterParams(params, 'size', v).toString()}`)
        }}
      >
        <SelectTrigger className="w-20" aria-label="Rows per page"><SelectValue /></SelectTrigger>
        <SelectContent>
          {LOG_PAGE_SIZES.map((size) => (
            <SelectItem key={size} value={String(size)}>{size}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function LogFilters({
  keys,
  models,
}: {
  keys: Array<{ id: string; name: string }>
  models: string[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [requestId, setRequestId] = useState('')

  function apply(name: string, value: string) {
    router.push(`/logs?${nextFilterParams(params, name, value).toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={params.get('range') ?? '24h'}
        // Base UI types the change value as nullable for clearable selects;
        // none of these has an empty item, so a null can only be spurious.
        onValueChange={(v) => { if (v) apply('range', v) }}
      >
        <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select
        value={params.get('key') ?? 'all'}
        onValueChange={(v) => { if (v) apply('key', v) }}
      >
        <SelectTrigger className="w-44"><SelectValue placeholder="Any key" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any key</SelectItem>
          {keys.map((k) => <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select
        value={params.get('model') ?? 'all'}
        onValueChange={(v) => { if (v) apply('model', v) }}
      >
        <SelectTrigger className="w-52"><SelectValue placeholder="Any model" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any model</SelectItem>
          {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select
        value={params.get('status') ?? 'all'}
        onValueChange={(v) => { if (v) apply('status', v) }}
      >
        <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <form
        className="ml-auto flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const id = requestId.trim()
          if (id) router.push(`/logs/${encodeURIComponent(id)}`)
        }}
      >
        <Input
          value={requestId}
          onChange={(event) => setRequestId(event.target.value)}
          placeholder="uuid…"
          className="w-48 font-mono text-xs"
          aria-label="Look up a request by its uuid"
        />
        <Button type="submit" variant="secondary">Find</Button>
      </form>
    </div>
  )
}
