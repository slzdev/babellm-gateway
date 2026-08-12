import type {
  CatalogFields, CatalogLayers, EffectiveFields, FieldSources, LayerName,
  MergeResult, ModelKind,
} from './types'

/** Highest precedence first. */
const LAYER_ORDER: readonly LayerName[] = ['override', 'discovered', 'registry', 'seed']

const VALUE_FIELDS = [
  'contextWindow', 'maxOutputTokens', 'inputPerMtok', 'outputPerMtok',
  'cachedInputPerMtok', 'supportsTools', 'supportsStreaming', 'modalities',
] as const satisfies readonly Exclude<keyof EffectiveFields, 'kind'>[]

/**
 * Last-resort classification for models no layer describes — OpenAI's
 * /v1/models reports nothing but an id, and models.dev has no entry for
 * whisper, tts or dall-e. Anything unrecognised stays `unknown` rather than
 * being guessed into `chat`: the picker groups unknown last, so a wrong guess
 * would be less visible than an honest one.
 */
export function inferKindFromId(modelId: string): ModelKind {
  const id = modelId.toLowerCase()
  if (/embed/.test(id)) return 'embedding'
  if (/whisper|(^|[-_/.])tts([-_/.]|$)|transcrib|speech/.test(id)) return 'audio'
  if (/dall-e|imagen|stable-?diffusion|flux|(^|[-_/.])sdxl([-_/.]|$)/.test(id)) return 'image'
  if (/(^|[-_/.])(veo|sora)([-_/.]|$)/.test(id)) return 'video'
  return 'unknown'
}

export function mergeCatalogFields(layers: CatalogLayers, modelId: string): MergeResult {
  const effective: Record<string, unknown> = {}
  const sources: FieldSources = {}

  for (const field of VALUE_FIELDS) {
    let resolved: CatalogFields[typeof field] = null

    for (const layer of LAYER_ORDER) {
      const candidate = layers[layer]?.[field]
      if (candidate !== undefined && candidate !== null) {
        resolved = candidate
        sources[field] = layer
        break
      }
    }

    effective[field] = resolved ?? null
  }

  let kind: ModelKind | null = null
  for (const layer of LAYER_ORDER) {
    const candidate = layers[layer]?.kind
    // 'unknown' means the layer looked and could not tell — not an answer.
    if (candidate && candidate !== 'unknown') {
      kind = candidate
      sources.kind = layer
      break
    }
  }
  if (!kind) {
    kind = inferKindFromId(modelId)
    sources.kind = 'heuristic'
  }
  effective.kind = kind

  return { effective: effective as unknown as EffectiveFields, sources }
}
