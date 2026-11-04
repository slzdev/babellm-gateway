import { ListFoundationModelsCommand, ListInferenceProfilesCommand, type BedrockClient, type FoundationModelSummary } from '@aws-sdk/client-bedrock'
import type { CatalogFields } from '@/lib/catalog/types'
import type { DiscoveredModel, ListModelsContext } from '../types'

function catalogFields(model: FoundationModelSummary): CatalogFields {
  const fields: CatalogFields = {}
  if (model.outputModalities?.includes('TEXT')) fields.kind = 'chat'
  if (model.inputModalities && model.outputModalities) {
    fields.modalities = { input: model.inputModalities.map((m) => m.toLowerCase()), output: model.outputModalities.map((m) => m.toLowerCase()) }
  }
  if (typeof model.responseStreamingSupported === 'boolean') fields.supportsStreaming = model.responseStreamingSupported
  return fields
}

export async function listModels(client: BedrockClient, ctx: ListModelsContext): Promise<DiscoveredModel[]> {
  // Fetch metadata for profile-only models too; ON_DEMAND is a filter on
  // direct invocations, not on foundations that enrich inference profiles.
  const foundations = await client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }), { abortSignal: ctx.signal })
  const metadata = new Map<string, FoundationModelSummary>()
  const models = new Map<string, DiscoveredModel>()
  for (const model of foundations.modelSummaries ?? []) {
    if (!model.modelId) continue
    metadata.set(model.modelId, model)
    if (model.inferenceTypesSupported?.includes('ON_DEMAND') && model.outputModalities?.includes('TEXT')) {
      models.set(model.modelId, { id: model.modelId, fields: catalogFields(model), raw: model })
    }
  }
  let nextToken: string | undefined
  do {
    // Do not catch individual pages: any denial/failure must discard the
    // entire result, letting catalog sync preserve its previous rows.
    const page = await client.send(new ListInferenceProfilesCommand({ ...(nextToken ? { nextToken } : {}) }), { abortSignal: ctx.signal })
    for (const profile of page.inferenceProfileSummaries ?? []) {
      if (profile.status !== 'ACTIVE') continue
      const id = profile.type === 'APPLICATION' ? profile.inferenceProfileArn : profile.inferenceProfileId
      if (!id || models.has(id)) continue
      const underlying = profile.models?.map((model) => {
        const suffix = model.modelArn?.split(':foundation-model/')[1]
        return suffix ? metadata.get(suffix) : undefined
      }).find((model) => model !== undefined)
      models.set(id, { id, fields: underlying ? catalogFields(underlying) : {}, raw: profile })
    }
    nextToken = page.nextToken
  } while (nextToken)
  return [...models.values()]
}
