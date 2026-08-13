import type { Content, Part } from '@google/genai'
import type { ChatMessage } from '@/lib/schemas/chat'

/**
 * Image parts already resolved to something Gemini accepts, keyed by the
 * client's original `image_url.url`. Built by `adapters/gemini/media.ts`,
 * because resolving one can mean a network fetch and an upload — the only I/O
 * this translation needs, and the reason it is done before translation rather
 * than during it. A url absent from the map could not be resolved; the part is
 * left out rather than failing the request.
 */
export type MediaParts = Map<string, Part>

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

function userParts(content: ChatMessage['content'], media: MediaParts): Part[] {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!content) return []

  const parts: Part[] = []
  for (const part of content) {
    if (part.type === 'text') {
      const { text } = part as { text: string }
      if (text.length > 0) parts.push({ text })
    } else if (part.type === 'image_url') {
      const { url } = (part as { image_url: { url: string } }).image_url
      const resolved = media.get(url)
      if (resolved) parts.push(resolved)
    }
    // Audio and every other part type has no Gemini equivalent reachable from
    // this ingress. droppedParams reports it; failing here would contradict the
    // compatibility decision the whole module is built on.
  }
  return parts
}

/**
 * A Chat Completions `tool` message names its call by id; Gemini's
 * functionResponse names it by function name. Nothing in the message bridges
 * those, so the bridge is built from the conversation itself — every id the
 * gateway emitted on a previous turn is still present in the assistant
 * messages the client echoed back.
 */
function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
  }
  return names
}

/** A JSON object, or null for anything else — an array and a bare scalar included. */
function asObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Reported by droppedParams rather than thrown.
  }
  return null
}

/**
 * `functionResponse.response` must be an object. Gemini reads an `output` key
 * as the function's return value, which is exactly what a non-JSON tool result
 * is.
 */
function toResponsePayload(text: string): Record<string, unknown> {
  return asObject(text) ?? { output: text }
}

export function toContents(
  messages: ChatMessage[],
  media: MediaParts,
): { contents: Content[]; systemInstruction: string } {
  const names = toolNamesById(messages)
  const contents: Content[] = []
  const system: string[] = []

  // Gemini expects alternation, and multi-turn clients routinely send two
  // messages in the same role in a row.
  function push(role: 'user' | 'model', parts: Part[]) {
    if (parts.length === 0) return
    const last = contents.at(-1)
    if (last?.role === role && last.parts) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // `contents` accepts only user and model, so there is nowhere to put
      // these. Hoisting preserves the authority the client gave the text;
      // carrying it as a user turn would silently demote it to the untrusted
      // channel. droppedParams reports the reorder when one happened.
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }

    if (message.role === 'tool' || message.role === 'function') {
      // The deprecated function role carries its name directly, which is
      // precisely what Gemini wants — it is better served here than by the
      // Responses translator, which has to degrade it to text.
      const name =
        message.role === 'function'
          ? message.name
          : message.tool_call_id
            ? names.get(message.tool_call_id)
            : undefined
      const text = textOf(message.content)

      // No name means nothing for a functionResponse to correlate to. Emitting
      // one with a fabricated name would send a dangling reference upstream, so
      // the result is carried as data instead. `user`, not the system channel:
      // a tool result is third-party data, and giving prompt-injected content
      // authority the original request never granted it is the failure mode.
      if (!name) {
        push('user', [{ text: `[tool result] ${text}` }])
        continue
      }

      push('user', [{
        functionResponse: {
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
          name,
          response: toResponsePayload(text),
        },
      }])
      continue
    }

    if (message.role === 'assistant') {
      const parts: Part[] = []
      const text = textOf(message.content)
      if (text.length > 0) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        // The client's id travels back out as functionCall.id and must return
        // unchanged, or a tool loop breaks silently on its second turn.
        parts.push({
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: asObject(call.function.arguments) ?? {},
          },
        })
      }
      push('model', parts)
      continue
    }

    push('user', userParts(message.content, media))
  }

  return { contents, systemInstruction: system.join('\n\n') }
}
