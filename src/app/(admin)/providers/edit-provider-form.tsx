'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FormDialog } from '@/components/admin/form-dialog'
import type { AdapterType } from '@/lib/adapters/credentials'
import { API_FLAVOR_LABELS, API_FLAVORS } from '@/lib/api-flavors'
import type { ProviderListItem } from '@/lib/admin/providers'
import { updateProviderAction, type ActionState } from './actions'
import { AdvancedPathsFields } from './advanced-paths-fields'
import { RegistryNamespaceField } from './registry-namespace-field'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '@/lib/timeouts'

const CREDENTIAL_FIELDS: Record<AdapterType, string[]> = {
  openai: ['apiKey', 'organization', 'project'],
  openai_compatible: ['apiKey', 'organization', 'project'],
  gemini: ['apiKey'],
  bedrock: ['region', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
}

export function EditProviderDialog({
  provider, open, onOpenChange,
}: {
  provider: ProviderListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<ActionState>
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${provider.name}`}
      description="Saving re-syncs this provider's models."
      action={updateProviderAction}
      submitLabel="Save and re-sync"
      successMessage="Provider updated."
    >
      <input type="hidden" name="id" value={provider.id} />
      <input type="hidden" name="adapter" value={provider.adapter} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`name-${provider.id}`}>Name</Label>
          <Input id={`name-${provider.id}`} name="name" defaultValue={provider.name} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`baseUrl-${provider.id}`}>Base URL</Label>
          <Input
            id={`baseUrl-${provider.id}`}
            name="baseUrl"
            defaultValue={provider.baseUrl ?? ''}
          />
        </div>
        {provider.adapter === 'openai' || provider.adapter === 'openai_compatible' ? (
          <div className="space-y-2">
            <Label htmlFor={`apiFlavor-${provider.id}`}>API flavor</Label>
            <select
              id={`apiFlavor-${provider.id}`}
              name="apiFlavor"
              defaultValue={provider.apiFlavor}
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
        <RegistryNamespaceField
          id={`ns-${provider.id}`}
          adapter={provider.adapter}
          defaultValue={provider.registryNamespace}
        />

        <div className="space-y-2">
          <Label htmlFor={`timeoutMs-${provider.id}`}>Request timeout (ms)</Label>
          <Input
            id={`timeoutMs-${provider.id}`}
            name="timeoutMs"
            type="number"
            min="1"
            max={MAX_TIMEOUT_MS}
            placeholder={String(DEFAULT_TIMEOUT_MS)}
            defaultValue={provider.timeoutMs ?? ''}
          />
          <p className="text-xs text-muted-foreground">
            How long one attempt may take before the gateway gives up and tries the
            next target. Blank uses {DEFAULT_TIMEOUT_MS} ms. Raise it for a provider
            that serves long requests.
          </p>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <div className="flex items-center gap-2">
            <Switch
              id={`forceUpstreamStream-${provider.id}`}
              name="forceUpstreamStream"
              defaultChecked={provider.forceUpstreamStream}
            />
            <Label htmlFor={`forceUpstreamStream-${provider.id}`}>Force upstream streaming</Label>
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

      <fieldset className="space-y-3">
        <legend className="text-xs text-muted-foreground">
          Credentials — leave a field blank to keep its stored value.
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {CREDENTIAL_FIELDS[provider.adapter].map((field) => (
            <div key={field} className="space-y-2">
              <Label htmlFor={`${field}-${provider.id}`}>{field}</Label>
              <Input
                id={`${field}-${provider.id}`}
                name={field}
                type={field.toLowerCase().includes('key') || field === 'sessionToken'
                  ? 'password'
                  : 'text'}
                autoComplete="off"
                placeholder={provider.maskedCredentials[field] ?? ''}
              />
            </div>
          ))}
        </div>
        {provider.adapter === 'bedrock' ? (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="useInstanceRole"
              defaultChecked={provider.maskedCredentials.useInstanceRole === 'true'}
            />
            Use the instance IAM role instead of access keys
          </label>
        ) : null}
      </fieldset>

      <AdvancedPathsFields
        idPrefix={provider.id}
        adapter={provider.adapter}
        values={provider.pathOverrides}
      />
    </FormDialog>
  )
}
