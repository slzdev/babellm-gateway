import { z } from 'zod'

export const embeddingsRequestSchema = z.looseObject({
  model: z.string().min(1),
  // All four shapes OpenAI accepts. The token forms are why this is a union
  // rather than `string | string[]`: a client that tokenizes locally sends
  // ids, and only some upstreams can take them — Gemini embeds text and so
  // refuses them outright rather than re-reading the ids as something else.
  //
  // The `.min(1)` on every array member is not upstream validation (an empty
  // *string* is left for the upstream to reject, as it is the authority on
  // what it can embed). It is the gateway's own need to tell the four shapes
  // apart: `[]` satisfies all three array members at once, so it names no
  // shape, and the shape is what decides whether a target can serve the
  // request at all.
  input: z.union([
    z.string(),
    z.array(z.string()).min(1),
    z.array(z.number().int()).min(1),
    z.array(z.array(z.number().int()).min(1)).min(1),
  ]),
  // The one parameter here the gateway reads rather than forwards blindly: it
  // governs what the OpenAI SDK does to the response body on the way back, so
  // an enum rather than a free string — a third value would leave the adapter
  // with no way to know whether the reply needs passing through verbatim.
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
})

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>
