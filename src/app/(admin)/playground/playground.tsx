'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from '@/components/ui/combobox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { PlaygroundModelOption } from '@/lib/admin/playground'
import { buildPlaygroundRequest, type PlaygroundTurn } from '@/lib/playground/request'
import { readChatResponse, type PlaygroundUsage } from '@/lib/playground/stream'

type RequestStats = {
  elapsedMs: number
  provider?: string | null
  upstreamModel?: string | null
  requestId?: string | null
  droppedParams?: string | null
  usage?: PlaygroundUsage
  finishReason?: string
}

type ActiveRequest = { controller: AbortController; turnId: string; startedAt: number }

export function Playground({ models }: { models: PlaygroundModelOption[] }) {
  const [model, setModel] = useState<PlaygroundModelOption | null>(models[0] ?? null)
  const [apiKey, setApiKey] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState('')
  const [maxCompletionTokens, setMaxCompletionTokens] = useState('')
  const [stream, setStream] = useState(true)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<PlaygroundTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<RequestStats | null>(null)
  const active = useRef<ActiveRequest | null>(null)
  const transcript = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    const request = active.current
    active.current = null
    request?.controller.abort()
  }, [])

  useEffect(() => {
    const request = active.current
    if (!busy || !request) return
    const timer = setInterval(() => {
      if (active.current !== request) return
      setStats((previous) => ({ ...previous, elapsedMs: performance.now() - request.startedAt }))
    }, 100)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    const element = transcript.current
    if (element) element.scrollTop = element.scrollHeight
  }, [turns])

  function newConversation() {
    const request = active.current
    active.current = null
    request?.controller.abort()
    setBusy(false)
    setTurns([])
    setDraft('')
    setError(null)
    setStats(null)
  }

  function stop() {
    const request = active.current
    if (!request) return
    active.current = null
    request.controller.abort()
    setBusy(false)
    setTurns((previous) => previous.map((turn) => turn.id === request.turnId ? { ...turn, status: 'stopped' } : turn))
    setStats((previous) => ({ ...previous, elapsedMs: performance.now() - request.startedAt }))
  }

  async function send() {
    // React state updates are asynchronous. Lock before the first await so a
    // second keyboard/button submit cannot start another gateway request.
    if (active.current) return
    let requestBody: ReturnType<typeof buildPlaygroundRequest>
    try {
      requestBody = buildPlaygroundRequest({
        model: model?.value ?? '', apiKey, systemPrompt, temperature, maxCompletionTokens, stream,
      }, turns, draft)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the request settings.')
      return
    }

    const request: ActiveRequest = {
      controller: new AbortController(), turnId: crypto.randomUUID(), startedAt: performance.now(),
    }
    active.current = request
    setBusy(true)
    setError(null)
    setStats({ elapsedMs: 0 })
    // A retry replaces the last incomplete display pair. Only completed pairs
    // enter request context, so its retained draft is sent exactly once.
    setTurns((previous) => {
      const last = previous.at(-1)
      const history = last && last.status !== 'complete' && last.prompt === draft ? previous.slice(0, -1) : previous
      return [...history, { id: request.turnId, prompt: draft, content: '', reasoning: '', status: 'pending' }]
    })

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requestBody.apiKey}`,
          'Content-Type': 'application/json',
          'x-babellm-tags': 'source=playground',
        },
        body: JSON.stringify(requestBody.body),
        signal: request.controller.signal,
      })
      if (active.current !== request) return
      setStats((previous) => ({
        ...previous, elapsedMs: performance.now() - request.startedAt,
        provider: response.headers.get('x-babellm-provider'),
        upstreamModel: response.headers.get('x-babellm-upstream-model'),
        requestId: response.headers.get('x-request-id'),
        droppedParams: response.headers.get('x-babellm-dropped-params'),
      }))
      for await (const event of readChatResponse(response)) {
        if (active.current !== request) return
        if (event.type === 'delta') {
          setTurns((previous) => previous.map((turn) => turn.id === request.turnId ? {
            ...turn, content: turn.content + event.content, reasoning: turn.reasoning + event.reasoning,
          } : turn))
        } else if (event.type === 'usage') {
          setStats((previous) => ({ ...previous, elapsedMs: performance.now() - request.startedAt, usage: event.usage }))
        } else {
          setStats((previous) => ({ ...previous, elapsedMs: performance.now() - request.startedAt, finishReason: event.reason }))
        }
      }
      if (active.current !== request) return
      setTurns((previous) => previous.map((turn) => turn.id === request.turnId ? { ...turn, status: 'complete' } : turn))
      setDraft('')
    } catch (cause) {
      if (active.current !== request) return
      setTurns((previous) => previous.map((turn) => turn.id === request.turnId ? { ...turn, status: 'failed' } : turn))
      setError(cause instanceof Error ? cause.message : 'The request failed. Check your connection and try again.')
    } finally {
      if (active.current === request) {
        active.current = null
        setBusy(false)
        setStats((previous) => ({ ...previous, elapsedMs: performance.now() - request.startedAt }))
      }
    }
  }

  if (models.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No chat models available</CardTitle>
          <CardDescription>Enable a provider and sync its catalog, or configure a virtual model with an enabled chat target.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button nativeButton={false} render={<Link href="/providers" />}>Configure providers</Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/models" />}>Configure virtual models</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <form className="grid min-w-0 items-start gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]" onSubmit={(event) => {
      event.preventDefault()
      void send()
    }}>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Requests use your key&apos;s normal limits, routing, and usage tracking.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={busy} className="min-w-0 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="playground-model">Model</Label>
              <Combobox
                items={models}
                value={model}
                disabled={busy}
                itemToStringLabel={(option: PlaygroundModelOption) => option.value}
                itemToStringValue={(option: PlaygroundModelOption) => option.value}
                isItemEqualToValue={(a: PlaygroundModelOption, b: PlaygroundModelOption) => a.value === b.value}
                onValueChange={(next: PlaygroundModelOption | null) => {
                  if (active.current || next?.value === model?.value) return
                  newConversation()
                  setModel(next)
                }}
              >
                <ComboboxInput id="playground-model" placeholder="Search models…" disabled={busy} className="w-full" />
                <ComboboxContent>
                  <ComboboxEmpty>No matching models.</ComboboxEmpty>
                  <ComboboxList>
                    {(option: PlaygroundModelOption) => (
                      <ComboboxItem key={option.value} value={option}>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs" title={option.value}>{option.value}</div>
                          <div className="text-xs text-muted-foreground">{option.group}</div>
                        </div>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="playground-key">Gateway API key</Label>
                <Link href="/keys" className="text-xs underline underline-offset-4">API keys</Link>
              </div>
              <Input id="playground-key" type="password" autoComplete="off" required value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-bab-…" />
              <p className="text-xs text-muted-foreground">Kept only in this page&apos;s memory.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="playground-system">System prompt <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="playground-system" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="You are a helpful assistant." className="max-h-64" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="playground-temperature">Temperature <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="playground-temperature" type="number" min="0" max="2" step="any" value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="Provider default" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="playground-tokens">Max completion tokens <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="playground-tokens" type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" value={maxCompletionTokens} onChange={(event) => setMaxCompletionTokens(event.target.value)} placeholder="Provider default" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="playground-stream">Stream response</Label>
              <Switch id="playground-stream" checked={stream} onCheckedChange={setStream} disabled={busy} />
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Conversation</CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={newConversation}>New conversation</Button>
          </div>
          <CardDescription>Text only. Conversation stays in memory until you leave or reload. Model changes start a new conversation.</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4">
          {/* shadcn has no conversation primitive; render escaped text without markdown or HTML execution. */}
          <div ref={transcript} role="log" aria-label="Conversation" aria-busy={busy} className="max-h-[60vh] min-h-48 space-y-5 overflow-y-auto rounded-lg border p-4 [overflow-wrap:anywhere]">
            {turns.length === 0 ? <p className="text-sm text-muted-foreground">Send a message to begin. Completed replies are included in follow-up requests.</p> : null}
            {turns.map((turn) => (
              <div key={turn.id} className="space-y-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">You</p>
                  <p className="whitespace-pre-wrap">{turn.prompt}</p>
                </div>
                <div className="space-y-2 rounded-lg bg-muted/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Assistant</span>
                    {turn.status !== 'complete' ? <Badge variant="secondary">{turn.status === 'pending' ? 'Responding…' : `${turn.status === 'stopped' ? 'Stopped' : 'Failed'} · incomplete`}</Badge> : null}
                  </div>
                  {turn.reasoning ? (
                    <Collapsible>
                      <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-4">Reasoning</CollapsibleTrigger>
                      <CollapsibleContent className="pt-2 text-sm whitespace-pre-wrap text-muted-foreground">{turn.reasoning}</CollapsibleContent>
                    </Collapsible>
                  ) : null}
                  {turn.content ? <p className="whitespace-pre-wrap">{turn.content}</p> : <p className="text-sm text-muted-foreground">{turn.status === 'pending' ? 'Waiting for response…' : 'No text returned.'}</p>}
                  {turn.status === 'failed' || turn.status === 'stopped' ? <p className="text-xs text-muted-foreground">This incomplete turn is excluded from follow-up context.</p> : null}
                </div>
              </div>
            ))}
          </div>

          {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
          {stats ? <RequestDetails stats={stats} busy={busy} /> : null}
          <div className="space-y-2">
            <Label htmlFor="playground-message">Message</Label>
            <Textarea id="playground-message" required disabled={busy} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask a question…" className="max-h-72 min-h-28" onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Ctrl/Cmd+Enter to send · Enter for a new line</p>
            {busy ? (
              <Button type="button" variant="outline" onClick={(event) => {
                // React reuses this button for Send after stop() clears busy.
                // Cancel activation before its type changes to submit.
                event.preventDefault()
                stop()
              }}>Stop</Button>
            ) : <Button type="submit" disabled={!model || !draft.trim() || !apiKey.trim()}>Send message</Button>}
          </div>
        </CardContent>
      </Card>
    </form>
  )
}

function RequestDetails({ stats, busy }: { stats: RequestStats; busy: boolean }) {
  const usage = stats.usage
  return (
    <div className="space-y-2 rounded-lg border p-3 text-xs text-muted-foreground [overflow-wrap:anywhere]" aria-label="Latest request details">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>{busy ? 'Elapsed' : 'Duration'}: {(stats.elapsedMs / 1000).toFixed(2)}s</span>
        <span>Provider: {stats.provider ?? 'Unknown'}</span>
        <span>Upstream model: {stats.upstreamModel ?? 'Unknown'}</span>
        {stats.finishReason ? <span>Finish: {stats.finishReason}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>Input tokens: {usage?.prompt_tokens ?? 'Unknown'}</span>
        <span>Output tokens: {usage?.completion_tokens ?? 'Unknown'}</span>
        <span>Total tokens: {usage?.total_tokens ?? 'Unknown'}</span>
        <span>Cost: {usage?.cost?.total != null ? `$${usage.cost.total}` : 'Unknown'}</span>
      </div>
      {stats.requestId ? <p>Request: <Link className="underline underline-offset-4" href={`/logs/${encodeURIComponent(stats.requestId)}`}>{stats.requestId}</Link></p> : null}
      {stats.droppedParams ? <p className="text-amber-700 dark:text-amber-400">The provider dropped unsupported parameters: {stats.droppedParams}.</p> : null}
    </div>
  )
}
