'use client'

import { ChevronRight } from 'lucide-react'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdapterType } from '@/lib/adapters/credentials'
import { PATH_FIELDS } from '@/lib/adapters/openai/paths'

/**
 * Per-endpoint path overrides, for a clone that hangs the OpenAI shape off
 * somewhere other than where the SDK looks for it. Collapsed by default
 * because a provider that needs one of these is the exception.
 *
 * Rendered only for the OpenAI-shaped adapters, which are the ones whose
 * requests go through the SDK that reads these. That gate is also what lets
 * the server action read an absent field as "not applicable" rather than
 * "cleared", so a gemini or bedrock provider cannot lose a stored value by
 * being saved from a form that never showed it.
 */
export function AdvancedPathsFields({ idPrefix, adapter, values = {} }: {
  idPrefix: string
  adapter: AdapterType
  values?: Record<string, string>
}) {
  if (adapter !== 'openai' && adapter !== 'openai_compatible') return null

  const overridden = PATH_FIELDS.filter((field) => values[field.name]).length

  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm">
        <ChevronRight
          className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
        />
        Advanced
        <span className="ml-auto text-xs text-muted-foreground">
          {overridden > 0
            ? `${overridden} custom endpoint path${overridden > 1 ? 's' : ''}`
            : 'Endpoint paths'}
        </span>
      </CollapsibleTrigger>

      {/*
        Kept mounted so a field that is edited and then collapsed still submits
        — an unmounted input would silently discard the change, and clearing a
        path is how the form says "go back to the default".
      */}
      <CollapsibleContent keepMounted className="space-y-3 border-t px-3 py-3">
        <p className="text-xs text-muted-foreground">
          Each path is appended to the base URL, which keeps carrying its own prefix.
          Leave a field blank to use the default.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PATH_FIELDS.map((field) => (
            <div key={field.name} className="space-y-1">
              <Label htmlFor={`${idPrefix}-${field.name}`} className="text-xs">
                {field.label}
              </Label>
              <Input
                id={`${idPrefix}-${field.name}`}
                name={field.name}
                defaultValue={values[field.name] ?? ''}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{field.help}</p>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
