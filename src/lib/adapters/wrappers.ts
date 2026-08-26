import {
  assertServiceable,
  fromCompletion,
  fromCompletionStream,
  toChatRequest,
} from '@/lib/translate/responses-to-chat'
import { newResponseId } from '@/lib/gateway/identity'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type { ChatOnlyAdapter, ProviderAdapter, TranscriptionResult } from './types'

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
 * hands this a `ChatOnlyAdapter` that also carries a native `transcribe` (see
 * openai/audio.ts), and that extra method must survive the `...adapter`
 * spread below in the *type* the caller sees, not just at runtime — otherwise
 * `createAdapter`'s declared return of a full `ProviderAdapter` would be a
 * lie the compiler couldn't catch anywhere else.
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
 * Supplies `transcribe` for an adapter that (for now, or permanently) has no
 * transcription implementation of its own. Two callers today: the
 * `anthropic_messages` flavor, whose host is Anthropic's API and accepts no
 * audio input of any kind — permanent, since no future task teaches it to
 * transcribe — and Gemini, temporarily, until Task 6 gives it a real
 * translated implementation (design doc §3.6). For the permanent case,
 * §3.5 filters such a target out of the routing chain before it is ever
 * attempted, so the throw is unreachable through the gateway; it exists
 * because `ProviderAdapter` requires the method and a direct unit call must
 * still behave. `reason` is surfaced verbatim to whoever reads the error — an
 * operator who misconfigured a route — so it should say *why* this provider
 * cannot serve, not just that it can't.
 *
 * Bounded by `ChatOnlyAdapter`, not `Omit<ProviderAdapter, 'transcribe'>`:
 * the registry always applies this after `withRespondViaChat`, so in
 * practice `adapter` already carries `respond`/`respondStream`, but nothing
 * here needs that — and requiring it would force the two wrappers' generic
 * inference to thread through each other at every call site for no benefit.
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
