export type PlaygroundUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: { total: string | null } | null
}

export type PlaygroundStreamEvent =
  | { type: 'delta'; content: string; reasoning: string }
  | { type: 'usage'; usage: PlaygroundUsage }
  | { type: 'finish'; reason: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): Error {
  return new Error('The gateway returned an invalid chat response.')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalidResponse()
  }
}

function errorMessage(value: unknown): string | undefined {
  if (!record(value)) return undefined
  if (typeof value.error === 'string') return value.error
  if (record(value.error) && typeof value.error.message === 'string') return value.error.message
  return undefined
}

function readUsage(value: unknown): PlaygroundUsage {
  if (!record(value)) throw invalidResponse()
  const usage: PlaygroundUsage = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const count = value[key]
    if (count === undefined || count === null) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalidResponse()
    usage[key] = count
  }
  if (value.cost === null) usage.cost = null
  else if (value.cost !== undefined) {
    if (!record(value.cost) || (value.cost.total !== null && typeof value.cost.total !== 'string')) {
      throw invalidResponse()
    }
    usage.cost = { total: value.cost.total }
  }
  return usage
}

function* readPayload(value: unknown, streamed: boolean): Generator<PlaygroundStreamEvent> {
  if (!record(value)) throw invalidResponse()
  if (value.error !== undefined) throw new Error(errorMessage(value) ?? 'The gateway reported a chat error.')
  if (!Array.isArray(value.choices) || (!streamed && value.choices.length === 0)) throw invalidResponse()
  const choice: unknown = value.choices[0]
  if (choice !== undefined) {
    if (!record(choice)) throw invalidResponse()
    const message = streamed ? choice.delta : choice.message
    if (!record(message)) throw invalidResponse()
    for (const key of ['content', 'reasoning_content'] as const) {
      if (message[key] != null && typeof message[key] !== 'string') throw invalidResponse()
    }
    const content = typeof message.content === 'string' ? message.content : ''
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (content || reasoning) yield { type: 'delta', content, reasoning }
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== 'string') throw invalidResponse()
      yield { type: 'finish', reason: choice.finish_reason }
    }
  }
  if (value.usage != null) yield { type: 'usage', usage: readUsage(value.usage) }
}

export async function* readChatResponse(response: Response): AsyncGenerator<PlaygroundStreamEvent> {
  if (!response.ok) {
    let message: string | undefined
    try { message = errorMessage(await response.json()) } catch { /* Status remains actionable for non-JSON errors. */ }
    throw new Error(`HTTP ${response.status}: ${message || response.statusText || 'The gateway request failed.'}`)
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    let value: unknown
    try { value = await response.json() } catch { throw invalidResponse() }
    yield* readPayload(value, false)
    return
  }
  if (!response.body) throw new Error('The gateway returned an empty response body.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const lines = frame.split(/\r?\n/)
          .filter((line) => line === 'data' || line.startsWith('data:'))
          .map((line) => line === 'data' ? '' : line.slice(5).replace(/^ /, ''))
        if (lines.length === 0) continue
        const data = lines.join('\n')
        if (data.trim() === '[DONE]') return
        yield* readPayload(parseJson(data), true)
      }
      if (done) throw new Error('The chat stream ended before [DONE]; the response may be incomplete.')
    }
  } finally {
    try { await reader.cancel() } catch { /* Preserve the original stream error. */ }
    reader.releaseLock()
  }
}
