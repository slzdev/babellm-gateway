'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { nextFilterParams } from '@/lib/admin/log-filter-params'

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
          placeholder="req_…"
          className="w-48 font-mono text-xs"
          aria-label="Look up a request id"
        />
        <Button type="submit" variant="secondary">Find</Button>
      </form>
    </div>
  )
}
