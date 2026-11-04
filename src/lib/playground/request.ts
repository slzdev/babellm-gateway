export type PlaygroundTurn = {
  id: string
  prompt: string
  content: string
  reasoning: string
  status: 'pending' | 'complete' | 'failed' | 'stopped'
}

export type PlaygroundSettings = {
  model: string
  apiKeyId: string
  systemPrompt: string
  temperature: string
  maxCompletionTokens: string
  stream: boolean
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string }
type ChatRequest = {
  model: string
  messages: Message[]
  stream: boolean
  stream_options?: { include_usage: true }
  temperature?: number
  max_completion_tokens?: number
}

export function buildPlaygroundRequest(settings: PlaygroundSettings, history: PlaygroundTurn[], draft: string): {
  apiKeyId: string; body: ChatRequest
} {
  const apiKeyId = settings.apiKeyId.trim()
  if (!apiKeyId) throw new Error('Select a gateway API key.')
  if (!settings.model.trim()) throw new Error('Select a model.')
  if (!draft.trim()) throw new Error('Enter a message.')

  const messages: Message[] = []
  if (settings.systemPrompt.trim()) messages.push({ role: 'system', content: settings.systemPrompt })
  for (const turn of history) {
    if (turn.status !== 'complete') continue
    messages.push({ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.content })
  }
  messages.push({ role: 'user', content: draft })
  const body: ChatRequest = { model: settings.model, messages, stream: settings.stream }
  if (settings.stream) body.stream_options = { include_usage: true }
  if (settings.temperature.trim()) {
    const temperature = Number(settings.temperature)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error('Temperature must be between 0 and 2.')
    }
    body.temperature = temperature
  }
  if (settings.maxCompletionTokens.trim()) {
    const tokens = Number(settings.maxCompletionTokens)
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new Error('Max completion tokens must be a positive whole number.')
    }
    body.max_completion_tokens = tokens
  }
  return { apiKeyId, body }
}
