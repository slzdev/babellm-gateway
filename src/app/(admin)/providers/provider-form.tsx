'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createProviderAction, type ActionState } from './actions'
import type { AdapterType } from '@/lib/adapters/credentials'

const ADAPTERS: AdapterType[] = ['openai', 'openai_compatible', 'gemini', 'bedrock']

export function ProviderForm() {
  const [adapter, setAdapter] = useState<AdapterType>('openai')
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createProviderAction,
    undefined,
  )

  return (
    <form action={action} className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Add a provider</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="openai-prod" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="adapter">Adapter</Label>
          <select
            id="adapter"
            name="adapter"
            value={adapter}
            onChange={(event) => setAdapter(event.target.value as AdapterType)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            {ADAPTERS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>

      {adapter === 'bedrock' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="region">Region</Label>
            <Input id="region" name="region" required placeholder="us-east-1" />
          </div>
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="useInstanceRole" /> Use the instance IAM role
          </label>
          <div className="space-y-2">
            <Label htmlFor="accessKeyId">Access key id</Label>
            <Input id="accessKeyId" name="accessKeyId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secretAccessKey">Secret access key</Label>
            <Input id="secretAccessKey" name="secretAccessKey" type="password" />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="apiKey">API key</Label>
            <Input id="apiKey" name="apiKey" type="password" required />
          </div>
          {adapter === 'openai_compatible' ? (
            <div className="space-y-2">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input id="baseUrl" name="baseUrl" required placeholder="https://api.x.ai/v1" />
            </div>
          ) : null}
        </div>
      )}

      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state?.success ? <p className="text-sm text-muted-foreground">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Add provider'}
      </Button>
    </form>
  )
}
