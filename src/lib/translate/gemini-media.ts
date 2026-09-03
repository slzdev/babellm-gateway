import type { Part } from '@google/genai'
import { ProviderError } from '@/lib/gateway/errors'

/**
 * URIs Gemini resolves by itself, from its own storage, and which already carry
 * a type server-side — so no mimeType is derived for them.
 */
const OWNED_URI = /^(gs:\/\/|https:\/\/generativelanguage\.googleapis\.com\/)/

const DATA_URI = /^data:([^;,]+)(;base64)?,([\s\S]*)$/

/**
 * Extension to MIME type, covering what Gemini documents as accepted for URL
 * input, plus the audio extensions `transcription-to-gemini.ts` resolves the
 * same way for an uploaded file's name. The map exists because `fileData`
 * requires a mimeType next to the uri — an empty one is a documented 400 —
 * while a Chat Completions content part carries only a url. A caller who has
 * a url this cannot type can say so directly with `mime_type` on the part.
 *
 * Exported for reuse: an uploaded transcription file's mime resolution is the
 * same "trust the caller's type, else fall back to the extension" rule this
 * module already applies to a media url, so the map is shared rather than
 * forked. No `webm` entry of its own for audio — the existing video/webm
 * entry already resolves it, and a video container's audio track transcribes
 * fine (see the mime-type note in transcription-to-gemini.ts).
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  // Images
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  // Videos
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
  avi: 'video/avi',
  flv: 'video/x-flv',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpg',
  webm: 'video/webm',
  wmv: 'video/wmv',
  // Audio. `m4a` is `audio/mp4`, not the unregistered `audio/m4a` some
  // guessers use — this is the mime-guessing mistake `mimeTypeFor` in
  // transcription-to-gemini.ts exists to avoid, one level down, and Apple
  // Voice Memos and iOS recordings default to this extension. `mpga` and
  // `oga` are added alongside `mp3`/`ogg` so a file that transcribes against
  // an OpenAI-shaped target (which accepts both) does not 400 here for no
  // reason a client can see.
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}

export type MediaKind = 'image' | 'video'

/**
 * A url with its query string and fragment removed. Both are stripped before
 * the extension is read — a pre-signed S3 or Azure url carries `?X-Amz-...`
 * after the object key — and this is also the only form of a url that reaches
 * an error message, because the query string of a pre-signed url is a usable
 * credential that must not be echoed back to a caller or into a log.
 */
function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0]
}

function badRequest(message: string): ProviderError {
  return new ProviderError({ status: 400, code: 'invalid_media', message, retryable: false })
}

function extensionMime(url: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(withoutQuery(url))
  return match ? (MIME_BY_EXTENSION[match[1].toLowerCase()] ?? null) : null
}

function inlinePart(url: string): Part {
  const match = DATA_URI.exec(url)
  // Only reached for a url that already matched `data:`, so a failure here is a
  // malformed one rather than a different scheme.
  if (!match) throw badRequest('a data: URI could not be parsed')

  const [, mimeType, base64, payload] = match
  try {
    // decodeURIComponent throws URIError on malformed percent-encoding, which
    // a non-base64 data: URI payload — untrusted client input — can trigger.
    const data = base64
      ? payload
      : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64')

    return { inlineData: { mimeType, data } }
  } catch {
    throw badRequest(`the ${mimeType} data: URI could not be decoded`)
  }
}

/**
 * Turns one client-supplied media url into the Part Gemini expects.
 *
 * Gemini accepts a public https or pre-signed url directly in `fileData`, so
 * nothing here fetches, uploads, or waits: the gateway never dereferences a
 * caller's url, which is what keeps this free of the SSRF surface and the
 * host-allowlist question that fetching one would raise. The retrieval, and
 * any failure of it, belongs to Google.
 *
 * A url that cannot be typed fails the whole request rather than being dropped
 * silently — a 400, and non-retryable, so the failover loop does not re-offer
 * the same unusable url to every remaining target.
 */
export function mediaPart(url: string, kind: MediaKind, mimeType?: string): Part {
  if (url.startsWith('data:')) return inlinePart(url)

  if (OWNED_URI.test(url)) {
    return { fileData: { fileUri: url, ...(mimeType ? { mimeType } : {}) } }
  }

  const resolved = mimeType ?? extensionMime(url)
  if (!resolved) {
    throw badRequest(
      `cannot determine the media type of ${withoutQuery(url)} — give it a known file extension, or set mime_type on the content part`,
    )
  }

  if (!resolved.startsWith(`${kind}/`)) {
    throw badRequest(`${withoutQuery(url)} is ${resolved}, which is not a ${kind}`)
  }

  return { fileData: { fileUri: url, mimeType: resolved } }
}
