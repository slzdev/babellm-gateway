import { z } from 'zod'

const textPart = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
})

const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
    // Not part of Chat Completions. A caller whose url carries no usable file
    // extension can name the type here rather than have the request refused;
    // adapters that do not need it ignore it.
    mime_type: z.string().optional(),
  }),
})

// Also outside Chat Completions, and named for the convention the OpenAI-
// compatible servers that carry video already use.
const videoPart = z.looseObject({
  type: z.literal('video_url'),
  video_url: z.looseObject({
    url: z.string(),
    mime_type: z.string().optional(),
  }),
})

const contentPart = z.union([
  textPart,
  imagePart,
  videoPart,
  z.looseObject({ type: z.string() }),
])

const content = z.union([z.string(), z.array(contentPart)])

const toolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    arguments: z.string(),
  }),
})

const message = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: content.nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
})

const tool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
})

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({
    type: z.literal('function'),
    function: z.looseObject({ name: z.string() }),
  }),
])

export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  stream: z.boolean().optional(),
  stream_options: z
    .looseObject({ include_usage: z.boolean().optional() })
    .nullable()
    .optional(),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  // Typed as a free string rather than an enum: the translator only needs to
  // know whether the client is addressing a reasoning model, and new effort
  // tiers appear faster than this schema would be updated.
  reasoning_effort: z.string().nullable().optional(),
  n: z.number().int().positive().nullable().optional(),
  stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  response_format: z.looseObject({ type: z.string() }).optional(),
  user: z.string().optional(),
})

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>
export type ChatMessage = z.infer<typeof message>
