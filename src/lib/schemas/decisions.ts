import { z } from 'zod'

// Bounds from the Decisions API reference, in characters as for the other
// gateway schemas. Arrays have no documented minimum length.
const shortText = z.string().max(1_048_576)
/** Validate in linear passes: repeated regex groups overflow V8's stack on
 * ordinary multi-megabyte inline images. */
function isInlineBase64ImageUrl(value: string): boolean {
  const comma = value.indexOf(',')
  if (comma < 0 || !/^data:image\/[a-zA-Z0-9.+-]+;base64$/.test(value.slice(0, comma))) return false

  const encoded = value.slice(comma + 1)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const payload = padding ? encoded.slice(0, -padding) : encoded
  if (!payload.length || /[^A-Za-z0-9+/]/.test(payload)) return false

  // Unpadded base64 may end with two or three characters, never one. Padded
  // encodings must fill a four-character block with exactly the missing '='s.
  if (!padding) return payload.length % 4 !== 1
  return encoded.length % 4 === 0 && payload.length % 4 === 4 - padding
}

const image = z.looseObject({
  type: z.literal('input_image'),
  image_url: z.string().max(1_073_741_824).refine(
    isInlineBase64ImageUrl,
    'Images must be base64-encoded image data URLs; external URLs and file IDs are not supported.',
  ),
  detail: z.enum(['low', 'high', 'auto', 'original']).nullable().optional(),
  file_id: z.never().optional(),
})
const inputPart = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('input_text'), text: z.string().max(10_485_760) }),
  image,
])
const inputMessage = z.looseObject({
  role: z.literal('user'),
  type: z.literal('message').optional(),
  content: z.union([z.string(), z.array(inputPart)]),
})
const questionFields = { instructions: shortText, name: shortText.optional() }
const question = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('predicate'), ...questionFields }),
  z.looseObject({
    type: z.literal('choice'), ...questionFields,
    choices: z.array(z.looseObject({ value: z.union([z.string(), z.boolean()]), description: shortText.optional() })),
  }),
  z.looseObject({
    type: z.literal('score'), ...questionFields,
    levels: z.array(z.looseObject({ label: shortText, description: shortText.optional() })),
  }),
])

export const decisionsRequestSchema = z.looseObject({
  model: shortText.min(1),
  input: z.union([z.string(), z.array(inputMessage)]),
  questions: z.array(question),
  safety_identifier: z.string().max(128).nullable().optional(),
  stream: z.boolean().optional().refine((value) => value !== true, {
    message: 'true is not supported: the Decisions API returns JSON and has no streaming form.',
  }),
}).superRefine((req, ctx) => {
  if (typeof req.input === 'string') return
  const images = req.input.reduce((count, message) => count + (
    typeof message.content === 'string' ? 0 : message.content.filter((part) => part.type === 'input_image').length
  ), 0)
  if (images > 128) ctx.addIssue({ code: 'custom', path: ['input'], message: 'At most 128 images are allowed across the request.' })
})

export type DecisionsRequest = z.infer<typeof decisionsRequestSchema>

// The SDK has no Decisions resource yet. These wire types retain extension
// properties just as the loose request objects do; the adapter never rewrites
// answers or usage, and a clone that omits usage remains unpriced.
type NamedAnswer = { name: string | null; [key: string]: unknown }
export type DecisionAnswer = NamedAnswer & (
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string | boolean; confidence: number; probabilities: { value: string | boolean; probability: number; [key: string]: unknown }[] }
  | { type: 'score'; score: number; confidence: number; probabilities: { label: string; value: number; probability: number; [key: string]: unknown }[] }
  | { type: 'refusal' }
)
export interface DecisionsResult {
  model: string
  answers: DecisionAnswer[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details: { cached_tokens: number; cache_write_tokens: number; [key: string]: unknown }
    output_tokens_details: { reasoning_tokens: number; [key: string]: unknown }
    [key: string]: unknown
  } | null
  [key: string]: unknown
}
