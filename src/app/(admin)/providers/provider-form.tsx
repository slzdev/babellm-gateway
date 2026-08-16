'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FormDialog } from '@/components/admin/form-dialog'
import { createProviderAction, type ActionState } from './actions'
import { AdvancedPathsFields } from './advanced-paths-fields'
import { CredentialField } from './provider-fields'
import { RegistryNamespaceField } from './registry-namespace-field'
import type { AdapterType } from '@/lib/adapters/credentials'

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

        <RegistryNamespaceField id="registryNamespace" adapter={adapter} />
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
