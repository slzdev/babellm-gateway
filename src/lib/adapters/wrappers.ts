import {
  assertServiceable,
  fromCompletion,
  fromCompletionStream,
  toChatRequest,
} from '@/lib/translate/responses-to-chat'
import { newResponseId } from '@/lib/gateway/identity'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type {
  ChatOnlyAdapter, EmbeddingsResult, ProviderAdapter, TranscriptionResult,
} from './types'

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

 * Generic in `A` rather than fixed to `ChatOnlyAdapter`: `createOpenAIAdapter`
 * hands this a `ChatOnlyAdapter` that also carries a native `transcribe` and a
 * native `embed` (see openai/audio.ts and openai/embeddings.ts), and those
 * extra methods must survive the `...adapter` spread below in the *type* the
 * caller sees, not just at runtime — otherwise `createAdapter`'s declared
 * return of a full `ProviderAdapter` would be a lie the compiler couldn't
 * catch anywhere else.
 */
export function withRespondViaChat<A extends ChatOnlyAdapter>(
  adapter: A,
  providerName: string,
): A & Pick<ProviderAdapter, 'respond' | 'respondStream'> {
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
 * Supplies `transcribe` for an adapter that has no transcription
 * implementation of its own. One caller: the `anthropic_messages` flavor,
 * whose host is Anthropic's API and accepts no audio input of any kind — a
 * permanent gap, not a placeholder. It exists because `ProviderAdapter`
 * requires the method and a direct unit call must still behave; through the
 * gateway, §3.5's routing filter steers a mixed model away from a target that
 * would only throw this, but its all-ineligible fallback still sends a model
 * whose only target is `anthropic_messages` here, so this throw is what
 * answers that request as a 501 — reachable by design, not dead code.
 * `reason` is surfaced verbatim to whoever reads the error — an operator who
 * misconfigured a route — so it should say *why* this provider cannot serve,
 * not just that it can't.
 *
 * Bounded by `ChatOnlyAdapter`, not the tighter `Omit<ProviderAdapter,
 * 'transcribe'>`: nothing in this function reads `respond`/`respondStream`,
 * so there is no reason to demand them. The registry happens to always call
 * this after `withRespondViaChat`, which satisfies either bound — but the
 * wider one also lets a bare chat-only adapter be wrapped directly, which is
 * exactly what the unit tests below do without first faking `respond`.
 */
export function withTranscribeUnsupported<A extends ChatOnlyAdapter>(
  adapter: A,
  providerName: string,
  reason: string,
): A & Pick<ProviderAdapter, 'transcribe'> {
  return {
    ...adapter,
    async transcribe(): Promise<TranscriptionResult> {
      throw new UnsupportedOperationError(
        `"${providerName}" cannot serve audio transcriptions: ${reason}.`,
      )
    },
  }
}

/**
 * Supplies `embed` for an adapter that has no embeddings implementation of its
 * own. The same shape as `withTranscribeUnsupported` above, and the same one
 * caller — the `anthropic_messages` flavor — because the two gaps have the
 * same cause: Anthropic's API serves neither endpoint, and nothing can be
 * derived from the one it does serve. `withRespondViaChat` manufactures a
 * Response out of a chat completion; no wrapper can manufacture an embedding
 * out of one, because a vector is not something a completion contains.
 *
 * Reachable through the gateway as well as from a direct unit call: §3.7's
 * routing filter steers a mixed model away from a target that would only throw
 * this, but its all-ineligible fallback sends a model whose *only* target is
 * `anthropic_messages` here, and this throw is that request's 501. `reason` is
 * read by the operator who misconfigured the route, so it says why the
 * provider cannot serve rather than only that it cannot.
 */
export function withEmbedUnsupported<A extends ChatOnlyAdapter>(
  adapter: A,
  providerName: string,
  reason: string,
): A & Pick<ProviderAdapter, 'embed'> {
  return {
    ...adapter,
    async embed(): Promise<EmbeddingsResult> {
      throw new UnsupportedOperationError(
        `"${providerName}" cannot serve embeddings: ${reason}.`,
      )
    },
  }
}
