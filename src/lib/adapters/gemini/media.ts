import type { GoogleGenAI, Part } from '@google/genai'
import type { ChatMessage } from '@/lib/schemas/chat'
import type { MediaParts } from '@/lib/translate/chat-to-gemini'

/** Gemini's own inline request limit, which an upload body should not exceed. */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

/** URIs Gemini already accepts by reference, so they need no upload. */
const FILE_URI = /^(gs:\/\/|https:\/\/generativelanguage\.googleapis\.com\/)/

const DATA_URI = /^data:([^;,]+)(;base64)?,([\s\S]*)$/

export interface MediaDeps {
  client: Pick<GoogleGenAI, 'files'>
  signal: AbortSignal
  requestId: string
  /** Injected by tests; production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch
  maxBytes?: number
}

/** Every distinct image url in the request, in first-seen order. */
export function imageUrls(messages: ChatMessage[]): string[] {
  const urls: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url
      if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

function inlinePart(url: string): Part | null {
  const match = DATA_URI.exec(url)
  if (!match) return null

  const [, mimeType, base64, payload] = match
  try {
    // decodeURIComponent throws URIError on malformed percent-encoding, which
    // a non-base64 data: URI payload — untrusted client input — can trigger.
    const data = base64
      ? payload
      : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64')

    return { inlineData: { mimeType, data } }
  } catch {
    return null
  }
}

/**
 * Reads the body while counting, rather than trusting Content-Length: a server
 * that lies about it — or omits it — would otherwise let an unbounded body into
 * memory.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('the image response carried no body')

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`the image is over the ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function uploadedPart(url: string, deps: MediaDeps): Promise<Part> {
  const fetchImpl = deps.fetchImpl ?? fetch
  // Redirects are followed by default. That is fine today — nothing here is
  // host-restricted yet — but whoever adds the host allowlist this ingress
  // needs must also set `redirect: 'manual'` and re-check each hop, or the
  // allowlist can be defeated by a redirect to an unlisted host.
  const res = await fetchImpl(url, { signal: deps.signal })
  if (!res.ok) throw new Error(`fetching it returned ${res.status}`)

  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!mimeType.startsWith('image/')) {
    throw new Error(`expected an image, got "${mimeType || 'no content type'}"`)
  }

  const body = await readCapped(res, deps.maxBytes ?? DEFAULT_MAX_BYTES)

  const file = await deps.client.files.upload({
    file: new Blob([body as BlobPart], { type: mimeType }),
    config: { mimeType, abortSignal: deps.signal },
  })

  // Images come back ACTIVE immediately, so `file.state` is not polled; the
  // wait would only pay off for the video and audio inputs this ingress cannot
  // carry anyway.
  if (!file.uri) throw new Error('the upload returned no file uri')

  return { fileData: { fileUri: file.uri, mimeType: file.mimeType ?? mimeType } }
}

function warn(requestId: string, url: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  // A pre-signed URL (S3, GCS, Azure SAS) carries its credential in the query
  // string, so this must never log past the `?` — doing so would write a
  // usable capability into stdout logs.
  const safeUrl = url.split('?')[0]
  console.warn(`[gemini] request_id=${requestId} dropped image ${safeUrl}: ${reason}`)
}

/**
 * Resolves every image in a request to something Gemini accepts, before any
 * translation runs. This is the only I/O on the translation path, and it lives
 * here precisely so `chat-to-gemini.ts` can stay pure and synchronous.
 *
 * A url that cannot be resolved is left out of the map, which the translator
 * reads as "omit this part". Failing the whole request over one unreachable
 * image would contradict the compatibility stance the layer is built on. It is
 * logged rather than reported through `x-babellm-dropped-params`, because that
 * header is computed from the request body before any attempt runs.
 *
 * Resolution is sequential rather than concurrent: a request carrying enough
 * images for that to matter is already the exception, and serial failures
 * produce log lines in a stable order.
 *
 * The one failure not swallowed is an aborted signal: it propagates so the
 * caller's own abort classification handles it, rather than being logged as
 * a dropped image.
 */
export async function resolveMedia(
  messages: ChatMessage[],
  deps: MediaDeps,
): Promise<MediaParts> {
  const resolved: MediaParts = new Map()

  for (const url of imageUrls(messages)) {
    if (url.startsWith('data:')) {
      const part = inlinePart(url)
      if (part) resolved.set(url, part)
      else warn(deps.requestId, url, new Error('the data: URI could not be parsed'))
      continue
    }

    if (FILE_URI.test(url)) {
      resolved.set(url, { fileData: { fileUri: url } })
      continue
    }

    try {
      resolved.set(url, await uploadedPart(url, deps))
    } catch (err) {
      // A client disconnect or attempt timeout mid-fetch surfaces here as an
      // AbortError too, and swallowing it would log a misleading "dropped
      // image" for what is actually a timeout, then spend a pointless
      // upstream call before the aborted signal fails it anyway. Re-throwing
      // is safe: resolveMedia already runs inside the same try block that
      // classifies upstream errors, so this becomes the 504 it should be.
      if (deps.signal.aborted) throw err
      warn(deps.requestId, url, err)
    }
  }

  return resolved
}
