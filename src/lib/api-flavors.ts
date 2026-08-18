/**
 * Which protocol a provider's endpoint speaks.
 *
 * Its own module rather than a constant in the schema or the admin layer,
 * because the provider and target dialogs are client components: they need
 * this list to render the selector, and both of those modules are server-only.
 * The schema's pgEnum is built from this array, so the column and the selector
 * cannot drift.
 */
export const API_FLAVORS = ['chat_completions', 'responses'] as const

export type ApiFlavor = (typeof API_FLAVORS)[number]

/** Human-readable labels for the raw enum values, shared by every selector
 *  that renders them — the target dialogs' `ApiFlavorSelect` and the
 *  provider dialogs alike — so the two screens read as one concept. */
export const API_FLAVOR_LABELS: Record<ApiFlavor, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
}
