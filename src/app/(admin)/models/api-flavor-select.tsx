'use client'

import { API_FLAVORS, type ApiFlavor } from '@/lib/api-flavors'

const LABELS: Record<ApiFlavor, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
}

/**
 * The flavor selector both target dialogs render.
 *
 * "(inherit)" submits an empty string, which the action turns back into NULL —
 * the value that makes the target follow its provider's setting.
 */
export function ApiFlavorSelect({
  id,
  defaultValue,
  providerDefault,
}: {
  id: string
  defaultValue?: ApiFlavor | null
  /** Shown in the inherit option so an operator can see what blank means
   *  without opening the Providers page. */
  providerDefault: ApiFlavor
}) {
  return (
    <select
      id={id}
      name="apiFlavor"
      defaultValue={defaultValue ?? ''}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">(inherit — {LABELS[providerDefault]})</option>
      {API_FLAVORS.map((flavor) => (
        <option key={flavor} value={flavor}>{LABELS[flavor]}</option>
      ))}
    </select>
  )
}
