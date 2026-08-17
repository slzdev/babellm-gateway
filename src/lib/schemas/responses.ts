import { z } from 'zod'

const inputContent = z.union([
  z.looseObject({ type: z.literal('input_text'), text: z.string() }),
  z.looseObject({ type: z.literal('input_image'), image_url: z.string().optional() }),
  z.looseObject({ type: z.literal('output_text'), text: z.string() }),
  z.looseObject({ type: z.string() }),
])

const inputItem = z.union([
  z.looseObject({
    type: z.literal('message'),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(inputContent)]),
  }),
  z.looseObject({
    type: z.literal('function_call'),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.looseObject({
    type: z.literal('function_call_output'),
    call_id: z.string(),
    output: z.string(),
  }),
  z.looseObject({ type: z.literal('reasoning') }),
  z.looseObject({ type: z.literal('item_reference'), id: z.string() }),
  // A shape this gateway has not been taught. Kept rather than rejected: on the
  // passthrough path the provider may well understand it, and the translator
  // reports it as dropped rather than refusing the request.
  z.looseObject({ type: z.string() }),
])

const tool = z.looseObject({ type: z.string() })

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({ type: z.string() }),
])

export const responsesRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(inputItem)]),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  max_tool_calls: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  text: z.looseObject({ format: z.looseObject({ type: z.string() }).optional() }).optional(),
  // Typed as a free string for the same reason as the chat schema's
  // reasoning_effort: new effort tiers appear faster than this would be updated.
  reasoning: z.looseObject({
    effort: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
  }).optional(),
  truncation: z.string().nullable().optional(),
  include: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  store: z.boolean().nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  conversation: z.union([z.string(), z.looseObject({ id: z.string() })]).nullable().optional(),
  prompt_cache_key: z.string().optional(),
  safety_identifier: z.string().optional(),
  // Rejected rather than dropped: a queued response would be unretrievable,
  // because GET /v1/responses/{id} is deliberately out of scope. Refusing at
  // parse time keeps it out of every path, not just the translated one.
  background: z.literal(false).nullable().optional(),
  service_tier: z.string().nullable().optional(),
  user: z.string().optional(),
})

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>
