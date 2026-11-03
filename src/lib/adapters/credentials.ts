import { z } from 'zod'

export const adapterTypes = ['openai', 'openai_compatible', 'gemini', 'bedrock'] as const
export type AdapterType = (typeof adapterTypes)[number]

const openaiCredentials = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
  organization: z.string().optional(),
  project: z.string().optional(),
})

const geminiCredentials = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
})

const bedrockCredentials = z.object({
  region: z.string().min(1, 'region is required').prefault(''),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  useInstanceRole: z.boolean().optional(),
}).superRefine((credentials, ctx) => {
  if (credentials.useInstanceRole === true) {
    for (const field of ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const) {
      if (credentials[field] !== undefined) {
        ctx.addIssue({
          code: 'custom', path: [field],
          message: 'Remove this field when using the AWS default credential chain.',
        })
      }
    }
  } else {
    for (const field of ['accessKeyId', 'secretAccessKey'] as const) {
      if (!credentials[field]) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required` })
      }
    }
  }
}).transform((credentials) => credentials.useInstanceRole === true
  ? { region: credentials.region, useInstanceRole: true as const }
  : {
    region: credentials.region,
    accessKeyId: credentials.accessKeyId!,
    secretAccessKey: credentials.secretAccessKey!,
    ...(credentials.sessionToken !== undefined ? { sessionToken: credentials.sessionToken } : {}),
  })

export const credentialSchemas: Record<AdapterType, z.ZodType> = {
  openai: openaiCredentials,
  openai_compatible: openaiCredentials,
  gemini: geminiCredentials,
  bedrock: bedrockCredentials,
}

/** Fields whose values must never be echoed back to the browser. */
const SECRET_FIELDS = new Set(['apiKey', 'secretAccessKey', 'sessionToken'])

export function maskCredentials(
  credentials: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials).map(([key, value]) => {
      const text = String(value)
      if (!SECRET_FIELDS.has(key)) return [key, text]
      return [key, `••••${text.slice(-4)}`]
    }),
  )
}
