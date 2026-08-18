import {
  assertServiceable,
  fromCompletion,
  fromCompletionStream,
  toChatRequest,
} from '@/lib/translate/responses-to-chat'
import { newResponseId } from '@/lib/gateway/identity'
import type { ChatOnlyAdapter, ProviderAdapter } from './types'

/**
 * The two crossing paths.
 *
 * Applied here, once, rather than implemented per adapter: there are two
 * dialects and four paths, of which two are identity, so exactly two wrappers
 * cover every adapter that will ever exist. A Gemini adapter gets `respond`
 * from the same wrapper the OpenAI chat adapter uses, and never learns that the
 * Responses API exists.
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

export function withChatViaResponses(adapter: ProviderAdapter): ProviderAdapter {
  // The Responses adapter already implements chat/chatStream through
  // chat-to-responses.ts, so this side needs no wrapping today. It exists as
  // the named counterpart so the registry reads symmetrically.
  return adapter
}
