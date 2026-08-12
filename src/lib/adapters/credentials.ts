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

const bedrockCredentials = z.union([
  z.object({
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  }),
  z.object({
    region: z.string().min(1),
    useInstanceRole: z.literal(true),
  }),
])

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
