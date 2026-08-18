import { droppedParams as anthropicDropped } from '@/lib/translate/chat-to-anthropic'
import { droppedParams as geminiDropped } from '@/lib/translate/chat-to-gemini'
import { droppedParams as responsesDropped } from '@/lib/translate/chat-to-responses'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { Candidate } from '../resolve'

/**
 * What one candidate cannot express of a Chat Completions request.
 *
 * One function rather than a conditional per ingress: both ingresses reduce
 * to this question, the adapter check has to come before the flavor check
 * (Gemini's adapter translates regardless of flavor, having no native
 * endpoint to be native on), and duplicating that ordering is how it gets
 * broken.
 */
export function droppedForChat(candidate: Candidate, req: ChatCompletionRequest): string[] {
  if (candidate.provider.adapter === 'gemini') return geminiDropped(req)
  if (candidate.apiFlavor === 'responses') return responsesDropped(req)
  if (candidate.apiFlavor === 'anthropic_messages') return anthropicDropped(req)
  // A chat_completions candidate is sent the request as it arrived, so there
  // is nothing it can fail to express.
  return []
}
