'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdapterType } from '@/lib/adapters/credentials'
import type { ProviderListItem } from '@/lib/admin/providers'
import { updateProviderAction, type ActionState } from './actions'

const CREDENTIAL_FIELDS: Record<AdapterType, string[]> = {
  openai: ['apiKey', 'organization', 'project'],
  openai_compatible: ['apiKey', 'organization', 'project'],
  gemini: ['apiKey'],
  bedrock: ['region', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
}

export function EditProviderForm({ provider }: { provider: ProviderListItem }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateProviderAction, undefined,
  )

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">Edit</summary>
      <form action={action} className="space-y-3 py-3">
        <input type="hidden" name="id" value={provider.id} />
        <input type="hidden" name="adapter" value={provider.adapter} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`name-${provider.id}`} className="text-xs">Name</Label>
            <Input id={`name-${provider.id}`} name="name" defaultValue={provider.name} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`baseUrl-${provider.id}`} className="text-xs">Base URL</Label>
            <Input
              id={`baseUrl-${provider.id}`}
              name="baseUrl"
              defaultValue={provider.baseUrl ?? ''}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ns-${provider.id}`} className="text-xs">Registry namespace</Label>
            <Input
              id={`ns-${provider.id}`}
              name="registryNamespace"
              defaultValue={provider.registryNamespace ?? ''}
              placeholder="groq"
            />
            <p className="text-xs text-muted-foreground">
              models.dev namespace for enriching this provider&apos;s models.
            </p>
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-xs text-muted-foreground">
            Credentials — leave a field blank to keep its stored value.
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {CREDENTIAL_FIELDS[provider.adapter].map((field) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`${field}-${provider.id}`} className="text-xs">{field}</Label>
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

        {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        {state?.warning ? <p role="alert" className="text-sm text-amber-600">{state.warning}</p> : null}
        {state?.success ? <p className="text-sm text-muted-foreground">{state.success}</p> : null}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save and re-sync'}
        </Button>
      </form>
    </details>
  )
}
