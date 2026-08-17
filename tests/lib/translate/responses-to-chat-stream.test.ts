import { expect, test } from 'vitest'
import { fromCompletionStream } from '@/lib/translate/responses-to-chat'

const req = { model: 'virtual', input: 'hi' }

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up',
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as never
}

// The real ResponseStreamEvent union only exposes fields common to every
// member (type, sequence_number) without narrowing. Tests read fields that
// exist on just one member at a time, so events are read back through this
// loose shape instead of fighting the union's discriminants at every call
// site — the runtime shape is what fromCompletionStream actually produced,
// this is purely a typechecking convenience.
type Ev = {
  type: string
  sequence_number: number
  output_index: number
  item: { type: string; [key: string]: unknown }
  text: string
  arguments: string
  response: { incomplete_details: unknown; usage: unknown }
}

async function collect(chunks: unknown[]): Promise<Ev[]> {
  const events: Ev[] = []
  for await (const event of fromCompletionStream((async function* () {
    for (const c of chunks) yield c as never
  })(), req, 'resp_1')) events.push(event as unknown as Ev)
  return events
}

test('opens with created and in_progress before any content', async () => {
  const events = await collect([chunk({ role: 'assistant' }), chunk({ content: 'hi' }, 'stop')])

  expect(events[0].type).toBe('response.created')
  expect(events[1].type).toBe('response.in_progress')
})

test('wraps text deltas in an item and a content part', async () => {
  const events = await collect([chunk({ content: 'he' }), chunk({ content: 'llo' }, 'stop')])
  const types = events.map((e) => e.type)

  expect(types).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
})

test('sequence numbers are monotonic from zero', async () => {
  const events = await collect([chunk({ content: 'hi' }, 'stop')])

  expect(events.map((e) => e.sequence_number)).toEqual([...events.keys()])
})

test('the assembled text arrives on output_text.done', async () => {
  const events = await collect([chunk({ content: 'he' }), chunk({ content: 'llo' }, 'stop')])
  const done = events.find((e) => e.type === 'response.output_text.done')!

  expect(done.text).toBe('hello')
})

test('reasoning opens its own item before the message', async () => {
  const events = await collect([
    chunk({ reasoning_content: 'thinking' }),
    chunk({ content: 'hi' }, 'stop'),
  ])
  const added = events.filter((e) => e.type === 'response.output_item.added')

  expect(added[0].item.type).toBe('reasoning')
  expect(added[0].output_index).toBe(0)
  expect(added[1].item.type).toBe('message')
  expect(added[1].output_index).toBe(1)
})

test('tool call deltas become function_call arguments deltas', async () => {
  const events = await collect([
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }),
    chunk({}, 'tool_calls'),
  ])

  const added = events.find((e) => e.type === 'response.output_item.added')!
  expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'f' })

  const done = events.find((e) => e.type === 'response.function_call_arguments.done')!
  expect(done.arguments).toBe('{"a":1}')
})

test('a length finish ends on response.incomplete', async () => {
  const events = await collect([chunk({ content: 'part' }), chunk({}, 'length')])
  const last = events.at(-1)!

  expect(last.type).toBe('response.incomplete')
  expect(last.response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
})

test('usage from the final chunk reaches response.completed', async () => {
  const withUsage = {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up', choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }
  const events = await collect([chunk({ content: 'hi' }, 'stop'), withUsage])

  expect(events.at(-1)!.response.usage).toMatchObject({ input_tokens: 4, output_tokens: 2 })
})
