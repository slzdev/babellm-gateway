import {
  assertServiceable,
  fromCompletion,
  fromCompletionStream,
  toChatRequest,
} from '@/lib/translate/responses-to-chat'
import { newResponseId } from '@/lib/gateway/identity'
import { collapseChatStream, collapseResponseStream } from './collapse'
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

/**
 * Opens the upstream leg as a stream even when the client asked for one body.
 *
 * Some providers refuse a non-streaming request outright once the model and
 * token budget put it over their long-request ceiling — Anthropic answers
 * "Streaming is required for operations that may take longer than 10 minutes"
 * before generating anything. The client's `stream` says what the CLIENT wants
 * to receive; whether the upstream leg is streamed is a property of the
 * endpoint, which is an operator's fact. This wrapper is how that fact gets
 * applied, under `force_upstream_stream` on the provider or the catalog model.
 *
 * Generic in `T` rather than typed to `ChatOnlyAdapter` so wrapping a full
 * `ProviderAdapter` returns a full `ProviderAdapter`: registry.ts composes
 * this with withForcedResponseStream on the Responses adapter, and a widened
 * return type there would drop `respond` on the floor.
 *
 * Draining the stream here rather than in the handler is also what keeps
 * failover working: `chat()` rejects before the gateway has committed an HTTP
 * response, so execute()'s chain sees an ordinary error and tries the next
 * target — where today the same mid-response failure is unrecoverable.
 */
export function withForcedChatStream<T extends ChatOnlyAdapter>(adapter: T): T {
  return {
    ...adapter,
    async chat(req, ctx) {
      return collapseChatStream(adapter.chatStream(req, ctx))
    },
  }
}

/**
 * The Responses-native counterpart. Only the Responses adapter needs it: every
 * other adapter reaches `respond` through withRespondViaChat, which is built
 * on the `chat` withForcedChatStream has already replaced.
 *
 * Applied on top of withForcedChatStream rather than instead of it, so a
 * Responses request never round-trips through chat shape merely because chat
 * is being forced too.
 */
export function withForcedResponseStream(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    async respond(req, ctx) {
      return collapseResponseStream(adapter.respondStream(req, ctx))
    },
  }
}
