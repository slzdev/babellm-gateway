'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FormDialog } from '@/components/admin/form-dialog'
import { createProviderAction, type ActionState } from './actions'
import { AdvancedPathsFields } from './advanced-paths-fields'
import { CredentialField } from './provider-fields'
import { RegistryNamespaceField } from './registry-namespace-field'
import type { AdapterType } from '@/lib/adapters/credentials'
import { API_FLAVOR_LABELS, API_FLAVORS } from '@/lib/api-flavors'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '@/lib/timeouts'

const ADAPTERS: AdapterType[] = ['openai', 'openai_compatible', 'gemini', 'bedrock']

export function CreateProviderDialog() {
  const [adapter, setAdapter] = useState<AdapterType>('openai')

  return (
    <FormDialog<ActionState>
      trigger={<Button>Add provider</Button>}
      title="Add a provider"
      description="Saving runs an immediate model sync."
      action={createProviderAction}
      submitLabel="Add provider"
      successMessage="Provider created."
    >
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

        {adapter === 'openai' || adapter === 'openai_compatible' ? (
          <div className="space-y-2">
            <Label htmlFor="apiFlavor">API flavor</Label>
            <select
              id="apiFlavor"
              name="apiFlavor"
              defaultValue="chat_completions"
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            >
              {API_FLAVORS.map((flavor) => (
                <option key={flavor} value={flavor}>{API_FLAVOR_LABELS[flavor]}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Choose Responses if this endpoint returns 404 on
              {' '}<code>/v1/chat/completions</code>. This is the default for
              every model on the provider — override it per model on the
              Catalog page.
            </p>
          </div>
        ) : null}

        <RegistryNamespaceField id="registryNamespace" adapter={adapter} />

        <div className="space-y-2">
          <Label htmlFor="timeoutMs">Request timeout (ms)</Label>
          <Input
            id="timeoutMs"
            name="timeoutMs"
            type="number"
            min="1"
            max={MAX_TIMEOUT_MS}
            placeholder={String(DEFAULT_TIMEOUT_MS)}
          />
          <p className="text-xs text-muted-foreground">
            How long one attempt may take in total, not just to its first byte.
            Reaching it before the first chunk means the gateway tries the next
            target; after it, a stream already in flight is cut short instead.
            Blank uses {DEFAULT_TIMEOUT_MS} ms. Raise it for a provider that
            serves long requests.
          </p>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <div className="flex items-center gap-2">
            <Switch id="forceUpstreamStream" name="forceUpstreamStream" />
            <Label htmlFor="forceUpstreamStream">Force upstream streaming</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Open the upstream request as a stream even when the client asked for a
            single response. Some providers refuse long non-streaming requests. The
            client still gets one response — only the upstream leg changes. This is
            the default for every model on the provider — override it per model on
            the Catalog page.
          </p>
        </div>
      </div>

      {adapter === 'bedrock' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <CredentialField id="region" name="region" label="Region" required placeholder="us-east-1" />
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="useInstanceRole" /> Use the instance IAM role
          </label>
          <CredentialField id="accessKeyId" name="accessKeyId" label="Access key id" />
          <CredentialField id="secretAccessKey" name="secretAccessKey" label="Secret access key" type="password" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <CredentialField id="apiKey" name="apiKey" label="API key" type="password" required />
          {adapter === 'openai_compatible' ? (
            <CredentialField id="baseUrl" name="baseUrl" label="Base URL" required placeholder="https://api.x.ai/v1" />
          ) : null}
        </div>
      )}

      <AdvancedPathsFields idPrefix="new" adapter={adapter} />
    </FormDialog>
  )
}
