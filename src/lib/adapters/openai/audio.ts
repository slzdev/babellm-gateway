import type OpenAI from 'openai'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'
import type { AttemptContext, TranscriptionResult } from '../types'
import { toProviderError } from './errors'

// `api_flavor` says which dialect a provider's *chat* endpoint speaks; it
// says nothing about the sibling endpoints on the same host, and
// GET /v1/models already works the same way regardless of flavor. A provider
// whose models are called on /responses still serves /audio/transcriptions
// at the usual place, so this one function is what both createOpenAIAdapter
// and createResponsesAdapter call — see design doc §3.4. Writing it twice,
// once per flavor, would just be two chances for the error mapping below to
// drift apart.
const FLAVOR_HINT =
  'If this endpoint does not implement the OpenAI-compatible audio transcriptions API, '
  + 'check the provider\'s documentation for the correct path and set an audioTranscriptionsPath '
  + 'override for it on the Catalog or Providers page.'

/**
 * Builds a `transcribe` implementation bound to one client and one resolved
 * path. `client` and `path` are the only two things that differ between the
 * Chat Completions and Responses flavors of an OpenAI-shaped provider — the
 * request shape, the upload, and the error handling are identical, because
 * this is the same host's sibling endpoint either way.
 */
export function transcribeVia(
  client: OpenAI,
  path: string,
): (req: TranscriptionRequest, ctx: AttemptContext) => Promise<TranscriptionResult> {
  return async (req, ctx) => {
    // `req.file` is passed through as-is, never re-wrapped or re-read here:
    // `execute` may call this twice for one request during failover, and a
    // `File`'s `Blob` backing is what makes a second read safe. Anything
    // that consumed it into a stream on the first attempt would leave the
    // second attempt with nothing to send.
    const params = {
      ...req,
      model: ctx.upstreamModel,
    } as OpenAI.Audio.TranscriptionCreateParamsNonStreaming

    try {
      return (await client.audio.transcriptions.create(params, {
        signal: ctx.signal,
        path,
      })) as TranscriptionResult
    } catch (err) {
      throw toProviderError(err, FLAVOR_HINT)
    }
  }
}
