import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { catalogModels } from '@/lib/db/schema'
import type { CostBreakdown, LogUsage, PricingSnapshot } from '@/lib/logs/types'

const SCALE = 9
const PER_MTOK = 1_000_000
/** Prices change monthly at most, and a catalog query per request on the hot
 * path would be a self-inflicted wound. A minute of staleness is the trade. */
const PRICE_TTL_MS = 60_000

const cache = new Map<string, { at: number; prices: PricingSnapshot | null }>()

export function clearPriceCache(): void {
  cache.clear()
}

export async function priceFor(
  providerId: string,
  upstreamModel: string,
): Promise<PricingSnapshot | null> {
  const key = `${providerId}:${upstreamModel}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.prices

  const [row] = await db
    .select({
      inputPerMtok: catalogModels.inputPerMtok,
      cachedInputPerMtok: catalogModels.cachedInputPerMtok,
      outputPerMtok: catalogModels.outputPerMtok,
    })
    .from(catalogModels)
    .where(and(
      eq(catalogModels.providerId, providerId),
      eq(catalogModels.modelId, upstreamModel),
    ))
    .limit(1)

  const prices = row
    ? {
        inputPerMtok: row.inputPerMtok,
        cachedInputPerMtok: row.cachedInputPerMtok,
        outputPerMtok: row.outputPerMtok,
      }
    : null

  cache.set(key, { at: Date.now(), prices })
  return prices
}

function usd(tokens: number, perMtok: string): string {
  // Float arithmetic at nine decimal places: the inputs are token counts and
  // per-million rates, so the products stay far inside the range where a
  // double is exact enough for a displayed cost.
  //
  // Known bound: this can misround the ninth decimal by 1 in roughly 0.3% of
  // (tokens, rate) pairs (e.g. tokens=75, rate=73.769460 yields
  // 0.005532709 where exact decimal arithmetic gives 0.005532710). That is
  // one nano-dollar, far below display precision, and is accepted
  // deliberately rather than pulling in a decimal library for it.
  return ((tokens * Number(perMtok)) / PER_MTOK).toFixed(SCALE)
}

/**
 * Turns catalog rates and measured tokens into a cost.
 *
 * Returns null — never zero — when the request cannot be priced. A dashboard
 * that shows $0.00 for an unpriced model is lying; one that shows "unpriced"
 * is not.
 */
export function computeCost(
  prices: PricingSnapshot | null,
  usage: LogUsage | null,
): CostBreakdown | null {
  if (!prices || !usage) return null
  if (prices.inputPerMtok === null || prices.outputPerMtok === null) return null
  // Half a price is not a price. "null, never zero" exists so the UI can say
  // "unpriced" instead of showing a number that quietly omits one side of the
  // request. A measured 0 is still a legitimate value and still prices.
  if (usage.promptTokens === null || usage.completionTokens === null) return null

  // Providers occasionally report more cached tokens than prompt tokens when
  // a cache hit spans a prefix. Cached is documented as a SUBSET of prompt,
  // so billing more tokens than were reported would contradict the invariant
  // this function exists to encode.
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens ?? 0)
  // OpenAI reports cached_tokens as a *subset* of prompt_tokens, so charging
  // both in full would double-count every cached request.
  const billablePrompt = Math.max((usage.promptTokens ?? 0) - cached, 0)
  const cachedRate = prices.cachedInputPerMtok ?? prices.inputPerMtok

  const inputUsd = usd(billablePrompt, prices.inputPerMtok)
  // A priceable request always gets a real cached figure, even when no
  // tokens were cached — `usd(0, rate)` is a legitimate zero. `null` stays
  // reserved for "the catalog could not price this" (the branches above),
  // never repurposed for "this component happened to be zero".
  const cachedUsd = usd(cached, cachedRate)
  const outputUsd = usd(usage.completionTokens ?? 0, prices.outputPerMtok)
  const totalUsd = (Number(inputUsd) + Number(cachedUsd) + Number(outputUsd)).toFixed(SCALE)

  return { inputUsd, cachedUsd, outputUsd, totalUsd, pricing: prices }
}
