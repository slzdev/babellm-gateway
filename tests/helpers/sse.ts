export interface SseEvent {
  data: string
}

export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      data: block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    }))
}

export function parseSseChunks(body: string): unknown[] {
  return parseSse(body)
    .filter((event) => event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data))
}

export function sseTerminated(body: string): boolean {
  return parseSse(body).at(-1)?.data === '[DONE]'
}
