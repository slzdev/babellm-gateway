/** Request shapes for Decisions, independent of the provider's chat protocol.
 * Client-safe so provider and Catalog selectors share the persisted values. */
export const DECISIONS_API_FLAVORS = ['openai'] as const
export type DecisionsApiFlavor = (typeof DECISIONS_API_FLAVORS)[number]
export const DECISIONS_API_FLAVOR_LABELS: Record<DecisionsApiFlavor, string> = {
  openai: 'OpenAI',
}
