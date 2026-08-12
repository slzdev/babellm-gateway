export const modelKinds = [
  'chat', 'embedding', 'image', 'audio', 'video', 'unknown',
] as const
export type ModelKind = (typeof modelKinds)[number]

export interface Modalities {
  input: string[]
  output: string[]
}

/** One layer's contribution. Absent and null both mean "this layer does not know". */
export interface CatalogFields {
  kind?: ModelKind | null
  contextWindow?: number | null
  maxOutputTokens?: number | null
  inputPerMtok?: number | null
  outputPerMtok?: number | null
  cachedInputPerMtok?: number | null
  supportsTools?: boolean | null
  supportsStreaming?: boolean | null
  modalities?: Modalities | null
}

export interface EffectiveFields {
  kind: ModelKind
  contextWindow: number | null
  maxOutputTokens: number | null
  inputPerMtok: number | null
  outputPerMtok: number | null
  cachedInputPerMtok: number | null
  supportsTools: boolean | null
  supportsStreaming: boolean | null
  modalities: Modalities | null
}

export type LayerName = 'override' | 'discovered' | 'registry' | 'seed'
export type FieldSource = LayerName | 'heuristic'
export type FieldSources = Partial<Record<keyof EffectiveFields, FieldSource>>

export interface CatalogLayers {
  override?: CatalogFields | null
  discovered?: CatalogFields | null
  registry?: CatalogFields | null
  seed?: CatalogFields | null
}

export interface MergeResult {
  effective: EffectiveFields
  sources: FieldSources
}
