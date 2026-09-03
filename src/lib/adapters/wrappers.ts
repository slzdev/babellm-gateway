import {
  assertServiceable,
  fromCompletion,
  fromCompletionStream,
  toChatRequest,
} from '@/lib/translate/responses-to-chat'
import { newResponseId } from '@/lib/gateway/identity'
import type { ChatOnlyAdapter, ProviderAdapter } from './types'

/**
 * The one crossing path that needs a wrapper.
 *
 * Two dialects make four paths — {chat, respond} × {chat-only adapter,
 * Responses-native adapter} — of which three are identity: a chat-only
 * adapter's own `chat`/`chatStream`, and a Responses-native adapter's own
 * `respond`/`respondStream` plus the `chat`/`chatStream` it implements
 * natively via chat-to-responses.ts (see registry.ts's `flavoredAdapter`). Only
 * a chat-only adapter's `respond`/`respondStream` has no native
 * implementation, which is what this function supplies. Applied here, once,
 * rather than implemented per adapter: a Gemini adapter gets
 * `respond`/`respondStream` from the same wrapper the OpenAI chat adapter
 * uses, and never learns that the Responses API exists.
 *
 * The spread is what carries everything else through, `embed` included: an
 * adapter that can embed keeps that ability after wrapping, and one that
 * cannot stays without it rather than gaining a stub. There is nothing to
 * supply here in either case — an embedding cannot be derived from a chat
 * completion the way a Response can.
 */
export function withRespondViaChat(
  adapter: ChatOnlyAdapter,
  providerName: string,
): ProviderAdapter {
  return {
    ...adapter,
    async respond(req, ctx) {
      assertServiceable(req, providerName)
      const completion = await adapter.chat(toChatRequest(req), ctx)
      return fromCompletion(completion, req, newResponseId())
    },
    async *respondStream(req, ctx) {
      assertServiceable(req, providerName)
      yield* fromCompletionStream(adapter.chatStream(toChatRequest(req), ctx), req, newResponseId())
    },
  }
}
