import { z } from 'zod'
import { GatewayError } from '@/lib/gateway/errors'

export const TRANSCRIPTION_FORMATS = ['json', 'verbose_json', 'text', 'srt', 'vtt'] as const
export type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number]

// The same ceiling the upstream API itself enforces (design doc §3.11): a
// request that would fail there fails here, before the bytes are ever sent,
// and a route handler with no body-size limit of its own never buffers an
// arbitrarily large upload only to have a provider reject it.
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export interface TranscriptionRequest {
  file: File
  model: string
  response_format: TranscriptionFormat
  language?: string
  prompt?: string
  temperature?: number
  timestamp_granularities?: ('word' | 'segment')[]
  include?: string[]
  languages?: string[]
  keywords?: string[]
  chunking_strategy?: 'auto' | Record<string, unknown>
}

/**
 * FormData → the plain object the schema below validates.
 *
 * A multipart body carries no types of its own: every value is a string (or
 * a `File`), and a repeated field arrives as several parts under one key.
 * This function does only that wire-level shape-fixing — collapsing repeats
 * into an array and stripping the trailing `[]` that is how every HTTP
 * client spells "this key repeats" — and leaves type coercion (numbers,
 * enums, JSON) to the schema, so there is exactly one place that decides
 * what `"0.2"` or `"true"` means.
 */
export function transcriptionFromForm(form: FormData): unknown {
  const result: Record<string, unknown> = {}
  for (const rawKey of new Set(form.keys())) {
    const repeated = rawKey.endsWith('[]')
    const key = repeated ? rawKey.slice(0, -2) : rawKey
    result[key] = repeated ? form.getAll(rawKey) : form.get(rawKey)
  }
  return result
}

// z.instanceof rather than a hand-rolled type check: a client that put the
// audio in the wrong part (a string value for `file`) fails with the same
// invalid_type shape every other required field below produces, which is
// what lets parseWith name the field without any special-casing here.
const audioFile = z
  .instanceof(File, { message: 'must be an uploaded file' })
  .refine((f) => f.size <= MAX_FILE_BYTES, {
    message: `exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`,
  })

// multipart has no way to encode a JSON object as its own part, so 'auto'
// and a serialized chunking config are the same wire field, told apart only
// by whether it parses. A non-'auto' string that isn't valid JSON is a
// client mistake, not a passthrough value: forwarding it upstream verbatim
// would just move the same rejection one hop later, with a worse message.
const chunkingStrategy = z
  .string()
  .transform((value, ctx): 'auto' | Record<string, unknown> => {
    if (value === 'auto') return 'auto'
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Falls through to the issue below either way.
    }
    ctx.addIssue({ code: 'custom', message: 'must be "auto" or a JSON object' })
    return z.NEVER
  })
  .optional()

const shape = z.looseObject({
  file: audioFile,
  model: z.string().min(1),
  response_format: z.enum(TRANSCRIPTION_FORMATS).default('json'),
  language: z.string().optional(),
  prompt: z.string().optional(),
  // Bounded 0–1 like every other temperature field in this codebase; arrives
  // as a string ("0.2") because every multipart value does.
  temperature: z.coerce.number().min(0).max(1).optional(),
  timestamp_granularities: z.array(z.enum(['word', 'segment'])).optional(),
  include: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  chunking_strategy: chunkingStrategy,
  // Not part of TranscriptionRequest — stripped below once it has done its
  // one job. An explicit 'true' | 'false' enum rather than z.coerce.boolean():
  // coercion treats any non-empty string, including the string "false", as
  // truthy, which is exactly the bug this field exists to catch one layer up.
  stream: z.enum(['true', 'false']).optional(),
})

export const transcriptionRequestSchema: z.ZodType<TranscriptionRequest> = shape.transform((data, ctx) => {
  // Thrown, not added as an issue: a streaming client needs a distinct
  // `unsupported_parameter` code and a message telling it what to do next,
  // and parseWith's issue-to-envelope mapping only ever produces
  // `invalid_request`. Throwing here propagates straight out of
  // `safeParse` uncaught, so the caller — parseWith or a direct `.parse()`
  // — sees exactly this GatewayError instead of a generic zod issue.
  // See design doc §3.7: ignoring the flag would leave the client holding
  // a JSON body it asked to receive as an event stream, which fails in a
  // way it cannot diagnose; refusing it tells the client what to do next.
  if (data.stream === 'true') {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'unsupported_parameter',
      param: 'stream',
      message: 'Streaming is not supported for audio transcriptions. Retry the request without `stream`.',
    })
  }

  // Enforced here rather than in the field's own schema because it depends
  // on another field's value — the exact case a superRefine/transform
  // exists for, and the same rule the upstream API applies.
  if (data.timestamp_granularities && data.response_format !== 'verbose_json') {
    ctx.addIssue({
      code: 'custom',
      path: ['timestamp_granularities'],
      message: "timestamp_granularities requires response_format: 'verbose_json' to be set alongside it",
    })
    return z.NEVER
  }

  const rest: Record<string, unknown> = { ...data }
  delete rest.stream
  return rest as unknown as TranscriptionRequest
})
