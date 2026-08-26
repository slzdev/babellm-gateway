import type { TranscriptionResult } from '@/lib/adapters/types'
import {
  transcriptionFromForm,
  transcriptionRequestSchema,
  type TranscriptionRequest,
} from '@/lib/schemas/transcription'
import { droppedParams, TIMESTAMPED_FORMATS } from '@/lib/translate/transcription-to-gemini'
import { withUsageCost } from '../cost'
import { GatewayError } from '../errors'
import { parseWith, type Ingress } from '../handler'
import type { Candidate } from '../resolve'
import { usageFromTranscription } from '../usage'

/**
 * `POST /v1/audio/transcriptions`, as an `Ingress`.
 *
 * The third dialect on the shared handler, and the first that is neither JSON
 * in nor always JSON out — which is what the `read`, `toResponse`, `supports`
 * and `captureRequest` seams exist for. Everything else about the request
 * (auth, tags, limits, routing, failover, the breaker, pricing, logging) is
 * the handler's, unchanged.
 */

/**
 * Whether this candidate can serve *this* request.
 *
 * The adapter is checked before the flavor, mirroring `createAdapter`: a
 * gemini-adapter provider gets the translated `transcribe` regardless of the
 * flavor label it carries, so a flavor-first ordering here would call such a
 * target unable to transcribe at all. `withTranscribeUnsupported` is applied
 * only inside `flavoredAdapter`, i.e. never to Gemini.
 *
 * Judged per request rather than per target because a Gemini target can
 * transcribe but returns no timestamps, and `verbose_json`, `srt` and `vtt`
 * are nothing but timestamps (design doc §3.6). Filtering it out of the chain
 * for exactly those three formats is what makes a mixed virtual model answer
 * an `srt` request from the target that has timestamps instead of coin-flipping
 * on which target selection picked — and what leaves it eligible for the two
 * formats it serves perfectly well.
 */
function supports(candidate: Candidate, req: TranscriptionRequest): boolean {
  if (candidate.provider.adapter === 'gemini') return !TIMESTAMPED_FORMATS.has(req.response_format)
  // Anthropic's API has no transcription endpoint and no audio input at all,
  // so this target could only ever burn an attempt, a breaker failure and a
  // round trip to report something the gateway already knew from its own
  // configuration.
  if (candidate.apiFlavor === 'anthropic_messages') return false
  return true
}

export const transcriptionIngress: Ingress<TranscriptionRequest, TranscriptionResult, never> = {
  read: async (request) => {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      // The multipart counterpart of `readJson`'s `invalid_json`. A client
      // that sent JSON to this endpoint has made a mistake worth naming:
      // without this it would see a confusing "file: must be an uploaded
      // file" instead of being told the body was the wrong kind entirely.
      throw new GatewayError({
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_form',
        message: 'Request body could not be read as multipart/form-data. Audio transcriptions are uploaded as a form with a `file` part.',
      })
    }
    // Outside the try on purpose: the schema throws its own `GatewayError` for
    // `stream: true`, and catching that here would relabel a precise
    // `unsupported_parameter` as "this was not a form".
    return parseWith(transcriptionRequestSchema, transcriptionFromForm(form))
  },
  modelOf: (req) => req.model,
  // Never: the schema refuses `stream: true` outright (design doc §3.7), so
  // this ingress declares none of the streaming members and the handler's
  // streaming branch is unreachable for it.
  isStream: () => false,
  supports,
  droppedFor: (candidate, req) =>
    candidate.provider.adapter === 'gemini' ? droppedParams(req) : [],
  run: (adapter, ctx, req) => adapter.transcribe(req, ctx),
  usageOf: (res) => (typeof res === 'string' ? null : usageFromTranscription(res.usage)),
  finish: (res, _identity, cost) => {
    // No identity rewriting at all: a transcription response has no `id` and
    // no `model` field, so there is nothing to rewrite and nothing to mint
    // (design doc §3.9) — hence no `newIdentityId` below either.
    //
    // A string result — `text`, `srt` or `vtt` — has no `usage` object to hang
    // the cost on and is returned exactly as the provider sent it. Only a
    // JSON result reaches `withUsageCost`, which is itself typed for objects.
    if (typeof res === 'string') return res
    return withUsageCost(res, cost)
  },
  /**
   * A string body is a text body.
   *
   * `Ingress` hands `toResponse` no format, and it deliberately stays that
   * way: the adapter already returns a string for exactly the three formats
   * that are not JSON (`text`, `srt`, `vtt`) and an object for the two that
   * are, so the result's own shape carries the answer with no second copy of
   * the format to disagree with the first.
   *
   * One `text/plain; charset=utf-8` for all three rather than
   * `application/x-subrip` and `text/vtt`: it is what the upstream API sends,
   * and the OpenAI SDK decides how to parse a response by asking whether the
   * content type is `application/json` — so a more precise type would change
   * nothing for a client while differing from what that client sees talking to
   * OpenAI directly (design doc §3.3).
   */
  toResponse: (res, headers) => {
    if (typeof res !== 'string') return Response.json(res, { headers })
    // `new Headers` rather than a spread: `HeadersInit` may be a `Headers`
    // instance or an entry list, and spreading either of those would silently
    // drop every attempt header.
    const textHeaders = new Headers(headers)
    textHeaders.set('content-type', 'text/plain; charset=utf-8')
    return new Response(res, { headers: textHeaders })
  },
  /**
   * The form's fields plus a description of the file — name, size, mime type —
   * and never its bytes.
   *
   * Audio is the largest thing that will ever pass through this endpoint and
   * the most sensitive: a call recording in a Postgres row is a liability the
   * byte cap reduces but does not remove, and truncated audio has no
   * diagnostic value anyway (design doc §3.10). The `File` stays on the
   * request the adapters are given — they need it, and failover needs it
   * re-readable — so the substitution happens here, at capture time, rather
   * than by stripping the request.
   */
  captureRequest: ({ file, ...fields }) => ({
    ...fields,
    file: { name: file.name, size: file.size, type: file.type },
  }),
}
