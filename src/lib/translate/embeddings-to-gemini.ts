import type { ContentListUnion, EmbedContentParameters, EmbedContentResponse } from '@google/genai'
import { ProviderError } from '@/lib/gateway/errors'
import type { AttemptContext, EmbeddingsResult } from '@/lib/adapters/types'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'

/**
 * The rejection, as opposed to the drops.
 *
 * `input` may be an array of token ids, which `embedContent` has no way to
 * accept — it embeds text, and the only thing the gateway could do with ids is
 * hand them over as something else. That would return vectors for content the
 * client never asked about: a right-shaped answer to the wrong question, which
 * is the one failure the "drop and report" rule cannot cover. So it is refused,
 * exactly as `assertServiceable` refuses a hosted tool on a chat-only target.
 *
 * Non-retryable twice over, for that function's reasons: it stops the chain
 * rather than replaying a request every Gemini target would refuse, and —
 * because `execute` reports health only for retryable failures — it cannot open
 * a circuit breaker on a target that is perfectly healthy.
 */
function refuseTokenInput(provider: string): ProviderError {
  return new ProviderError({
    status: 400,
    code: 'unsupported_input',
    message: `Token-array \`input\` cannot be embedded by provider "${provider}", which embeds text and would have to reinterpret the ids as something else. Send the input as a string or an array of strings, or route this model to an OpenAI-shaped provider.`,
    retryable: false,
  })
}

/**
 * A response the upstream accepted and then did not answer. 502 rather than
 * 400 because nothing about the request was rejected, and retryable because a
 * sibling target — or the same one on a second attempt — can still serve it;
 * this is the same reading `toProviderError` gives an uninterpretable failure.
 * The alternative, returning the short list, would hand the client a `data`
 * array whose positions no longer name the inputs they came from.
 */
function upstreamFailure(detail: string): ProviderError {
  return new ProviderError({
    status: 502,
    code: 'upstream_error',
    message: `Gemini returned no usable embeddings: ${detail}`,
    retryable: true,
  })
}

/** How many vectors the request asks for, which is also the count of `contents`. */
function inputCount(input: EmbeddingsRequest['input']): number {
  return typeof input === 'string' ? 1 : input.length
}

function toContents(input: EmbeddingsRequest['input'], provider: string): ContentListUnion {
  if (typeof input === 'string') return [input]
  // The schema's `.min(1)` on every array member means an array names exactly
  // one of the four input shapes, so this decides the shape rather than
  // guessing at it.
  if (input.every((value) => typeof value === 'string')) return input
  throw refuseTokenInput(provider)
}

export function toEmbedParams(
  req: EmbeddingsRequest,
  ctx: AttemptContext,
  provider: string,
): EmbedContentParameters {
  return {
    model: ctx.upstreamModel,
    contents: toContents(req.input, provider),
    config: {
      abortSignal: ctx.signal,
      ...(req.dimensions === undefined ? {} : { outputDimensionality: req.dimensions }),
      // `taskType` is left unset deliberately: nothing in the OpenAI dialect
      // says what the vectors are for, and picking one here would change the
      // embedding a client gets for reasons it could neither see nor override.
    },
  }
}

/**
 * The bytes OpenAI puts on the wire for `encoding_format: 'base64'`: each value
 * as a little-endian IEEE-754 single, concatenated, base64'd.
 *
 * Written through a DataView rather than `Float32Array`'s own buffer because
 * that buffer is host-endian. Every platform this runs on today is
 * little-endian, so the two agree — but the wire format is fixed and the host's
 * is not, and a gateway that silently swapped byte order on a big-endian
 * machine would produce vectors no client could decode.
 */
export function toBase64(values: number[]): string {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true)
  return Buffer.from(buffer).toString('base64')
}

export function fromEmbedContent(
  res: EmbedContentResponse,
  req: EmbeddingsRequest,
  model: string,
): EmbeddingsResult {
  const embeddings = res.embeddings ?? []
  const wanted = inputCount(req.input)

  if (embeddings.length !== wanted) {
    throw upstreamFailure(`expected ${wanted}, got ${embeddings.length}`)
  }

  const asBase64 = req.encoding_format === 'base64'
  const data = embeddings.map((embedding, index) => {
    // `values` is optional on the SDK type. An entry without it is a hole in
    // the list, and a hole cannot be filled with an empty vector: that is a
    // valid-looking embedding of nothing.
    if (!embedding.values) throw upstreamFailure(`embedding ${index} carries no values`)
    return {
      object: 'embedding' as const,
      index,
      embedding: asBase64 ? toBase64(embedding.values) : embedding.values,
    }
  })

  // Cast for two reasons the SDK's own response type cannot express. `usage` is
  // required there and absent here: the Developer API measures nothing for
  // `embedContent` (`statistics` and `metadata.billableCharacterCount` are
  // Vertex/GEAP-only), and a fabricated usage object would claim a measurement
  // that never happened — `usageFromEmbeddings` reads its absence as unpriced,
  // which is the honest answer. And `embedding` is typed `number[]` even though
  // OpenAI itself returns a string under `encoding_format: 'base64'`.
  return { object: 'list', model, data } as unknown as EmbeddingsResult
}

/**
 * Parameters this translation cannot carry. Dropped rather than rejected, for
 * chat-to-gemini's reason: SDKs send `user` meaning nothing by it, and it
 * cannot change which vectors come back.
 *
 * `service_tier` is here even though the OpenAI embeddings API documents none,
 * so no client can have sent one. A route target can *pin* one, and the handler
 * computes the dropped set against the body the winning target was actually
 * sent — so an operator who pins a tier and then routes to Gemini learns the
 * pin did nothing, instead of having to infer it from unchanged latency.
 *
 * `encoding_format` is not here — it is honoured, gateway-side, by
 * `fromEmbedContent`. Nor is `dimensions`, which maps directly.
 */
const UNMAPPABLE = ['service_tier', 'user'] as const

export function droppedParams(req: EmbeddingsRequest): string[] {
  const dropped: string[] = []
  for (const name of UNMAPPABLE) {
    const value = (req as Record<string, unknown>)[name]
    // An empty string is what an SDK sends for "unset"; reporting it would put
    // a line in the header for a parameter the caller did not really use.
    if (value === undefined || value === null || value === '') continue
    dropped.push(name)
  }
  return dropped
}
