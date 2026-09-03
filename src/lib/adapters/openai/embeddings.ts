import type OpenAI from 'openai'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'
import type { AttemptContext, EmbeddingsResult } from '../types'
import { toProviderError } from './errors'

/**
 * The hint the two chat adapters pass names a flavor, because a 404 on
 * `/chat/completions` really is evidence that the endpoint speaks another
 * dialect. A 404 here is no such evidence: `/embeddings` is a sibling of both
 * chat dialects rather than one of them, so a flavor is not the lever that
 * fixes it and offering it would send the reader to change a setting that
 * cannot be wrong for this request. The path is the lever — a clone that
 * serves embeddings elsewhere, or does not serve them at all.
 */
const PATH_HINT =
  'If this provider serves embeddings from another path, set its embeddings path — or this one model\'s, on the Catalog page. A provider with no embeddings endpoint at all cannot answer this request.'

/**
 * `embed` for both OpenAI-dialect entry points. It is shared rather than
 * written twice because the flavor selects the *chat* dialect only: a model
 * answering the Responses API is still reached through the same OpenAI client,
 * and embeddings are a sibling endpoint, not a third dialect.
 */
export async function embed(
  client: OpenAI,
  req: EmbeddingsRequest,
  ctx: AttemptContext,
  path: string,
): Promise<EmbeddingsResult> {
  const params = {
    ...req,
    model: ctx.upstreamModel,
    // Do not remove this, and do not make it conditional. The SDK rewrites
    // the parameter when the caller omits it: it sends `base64` upstream and
    // decodes the reply into a Float32Array, which JSON.stringify renders as
    // {"0":0.1,…} — an object no OpenAI client can read as an embedding.
    // Setting it explicitly is the only thing that makes the SDK hand back the
    // upstream body untouched, which is all a gateway may do with it. A client
    // that asked for base64 gets its strings through unchanged.
    // See openai/resources/embeddings.mjs.
    encoding_format: req.encoding_format ?? 'float',
  } as OpenAI.Embeddings.EmbeddingCreateParams

  try {
    return await client.embeddings.create(params, { signal: ctx.signal, path })
  } catch (err) {
    throw toProviderError(err, PATH_HINT)
  }
}
