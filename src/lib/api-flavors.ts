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
