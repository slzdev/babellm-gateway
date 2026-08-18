'use client'

/**
 * The per-model forced-streaming override. A three-option select rather than a
 * switch, because the field is genuinely tri-state: a model can inherit its
 * provider, force, or refuse to force where its provider does. A switch has
 * nowhere to put the third.
 *
 * Lives in components/admin beside api-flavor-select for the same reason: the
 * dialogs that render it are client components and cannot import the
 * server-only admin modules the values come from.
 *
 * "(inherit)" submits an empty string, which the action turns back into NULL.
 */
export function ForceStreamSelect({
  id,
  defaultValue,
  providerDefault,
}: {
  id: string
  defaultValue?: boolean | null
  /** Shown in the inherit option so an operator can see what blank means
   *  without opening the Providers page. */
  providerDefault: boolean
}) {
  return (
    <select
      id={id}
      name="forceUpstreamStream"
      defaultValue={defaultValue === null || defaultValue === undefined ? '' : String(defaultValue)}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">
        (inherit — {providerDefault ? 'forced' : 'not forced'})
      </option>
      <option value="true">Force</option>
      <option value="false">Never force</option>
    </select>
  )
}
