import { expect, test } from 'vitest'
import {
  droppedParams,
  fromResponse,
  fromResponseStream,
  toResponsesRequest,
} from '@/lib/translate/chat-to-responses'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import streamFixture from '../../fixtures/openai-responses-tool-call-stream.json'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'house-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-5-mini',
    status: 'completed',
    incomplete_details: null,
    output: [],
    ...overrides,
  } as never
}

const usage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
  output_tokens: 12,
  output_tokens_details: { reasoning_tokens: 6 },
  total_tokens: 52,
}

test('substitutes the upstream model and pins store to false', () => {
  const params = toResponsesRequest(request(), 'gpt-5-mini')
  expect(params.model).toBe('gpt-5-mini')
  expect(params.store).toBe(false)
})

test('system and developer messages keep their role and position', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'use json' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'developer', content: 'use json' },
  ])
})

test('content parts become input_text and input_image', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'low' } },
        ],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([{
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'low' },
    ],
  }])
})

test('an image without a detail defaults to auto', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
      }],
    }),
    'm',
  )

  expect((params.input as never[])[0]).toMatchObject({
    content: [{ type: 'input_image', detail: 'auto' }],
  })
})

test('assistant tool calls become function_call items carrying the call id', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'user', content: 'weather?' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ])
})

test('an assistant message with both text and tool calls emits both, text first', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{
          id: 'call_9', type: 'function',
          function: { name: 'f', arguments: '{}' },
        }],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'assistant', content: 'let me check' },
    { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{}' },
  ])
})

test('a legacy function message is carried as text rather than a dangling call_id', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'function', name: 'get_weather', content: '18C' },
      ],
    } as never),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'user', content: 'weather?' },
    { role: 'developer', content: '[function result: get_weather] 18C' },
  ])
})

test('no function_call_output is emitted for a legacy function message', () => {
  const params = toResponsesRequest(
    request({ messages: [{ role: 'function', name: 'f', content: 'x' }] } as never),
    'm',
  )
  const items = params.input as { type?: string }[]
  expect(items.some((item) => item.type === 'function_call_output')).toBe(false)
})

test('droppedParams reports a legacy function message', () => {
  expect(
    droppedParams(request({
      messages: [{ role: 'function', name: 'f', content: 'x' }],
    } as never)),
  ).toEqual(['legacy_function_message'])
})

test('a modern tool message still becomes function_call_output', () => {
  const params = toResponsesRequest(
    request({
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' }],
    } as never),
    'm',
  )

  expect(params.input).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ])
})

test('tools flatten out of their function wrapper', () => {
  const params = toResponsesRequest(
    request({
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'look up weather',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      }],
    }),
    'm',
  )

  expect(params.tools).toEqual([{
    type: 'function',
    name: 'get_weather',
    description: 'look up weather',
    parameters: { type: 'object', properties: {} },
    strict: true,
  }])
})

test('a named tool_choice flattens the same way', () => {
  const params = toResponsesRequest(
    request({ tool_choice: { type: 'function', function: { name: 'f' } } }),
    'm',
  )
  expect(params.tool_choice).toEqual({ type: 'function', name: 'f' })
})

test('a string tool_choice passes through', () => {
  expect(toResponsesRequest(request({ tool_choice: 'required' }), 'm').tool_choice)
    .toBe('required')
})

test('max_completion_tokens wins over max_tokens', () => {
  const params = toResponsesRequest(
    request({ max_tokens: 10, max_completion_tokens: 99 }),
    'm',
  )
  expect(params.max_output_tokens).toBe(99)
})

test('max_tokens is used when max_completion_tokens is absent', () => {
  expect(toResponsesRequest(request({ max_tokens: 10 }), 'm').max_output_tokens).toBe(10)
})

test('a json_schema response format flattens into text.format', () => {
  const params = toResponsesRequest(
    request({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    } as never),
    'm',
  )

  expect(params.text).toEqual({
    format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
  })
})

test('a json_object response format maps to text.format', () => {
  const params = toResponsesRequest(
    request({ response_format: { type: 'json_object' } }),
    'm',
  )
  expect(params.text).toEqual({ format: { type: 'json_object' } })
})

test('user maps to safety_identifier', () => {
  expect(toResponsesRequest(request({ user: 'u-1' }), 'm').safety_identifier).toBe('u-1')
})

test('reasoning is not requested when the client gave no reasoning_effort', () => {
  expect(toResponsesRequest(request(), 'm').reasoning).toBeUndefined()
})

test('reasoning_effort asks for a summary alongside the effort', () => {
  const params = toResponsesRequest(request({ reasoning_effort: 'high' } as never), 'm')
  expect(params.reasoning).toEqual({ effort: 'high', summary: 'auto' })
})

test('the provider config can request summaries without a client hint', () => {
  const params = toResponsesRequest(request(), 'm', { requestReasoningSummary: true })
  expect(params.reasoning).toEqual({ summary: 'auto' })
})

test('unmappable parameters never appear in the upstream request', () => {
  const params = toResponsesRequest(
    request({ n: 3, stop: ['\n'], seed: 7, frequency_penalty: 0.5 } as never),
    'm',
  )

  for (const key of ['n', 'stop', 'seed', 'frequency_penalty']) {
    expect(params).not.toHaveProperty(key)
  }
})

test('droppedParams names the parameters that were discarded', () => {
  expect(droppedParams(request({ n: 3, stop: ['\n'], seed: 7 } as never)).sort())
    .toEqual(['n', 'seed', 'stop'])
})

test('droppedParams stays silent about inert defaults', () => {
  expect(droppedParams(request({
    n: 1, frequency_penalty: 0, presence_penalty: 0, temperature: 0.7,
  } as never))).toEqual([])
})

test('droppedParams reports audio content parts', () => {
  const dropped = droppedParams(request({
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }],
    }],
  } as never))

  expect(dropped).toContain('audio_content')
})

test('a request with nothing unmappable drops nothing', () => {
  expect(droppedParams(request({ temperature: 0.2, top_p: 1 }))).toEqual([])
})

test('output_text parts concatenate into the message content', () => {
  const result = fromResponse(response({
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [
        { type: 'output_text', text: 'Hello ', annotations: [] },
        { type: 'output_text', text: 'world', annotations: [] },
      ],
    }],
  }))

  expect(result.object).toBe('chat.completion')
  expect(result.created).toBe(1700000000)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.content).toBe('Hello world')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('a function_call item becomes a tool call keeping its call id', () => {
  const result = fromResponse(response({
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed',
    }],
  }))

  // The SDK types tool_calls as a union of function and custom tool calls;
  // fromResponse only ever produces the function variant.
  const call = result.choices[0].message.tool_calls?.[0] as
    | { id: string; function: { name: string } }
    | undefined
  expect(call?.id).toBe('call_1')
  expect(call?.function.name).toBe('get_weather')
  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('reasoning summaries land on reasoning_content', () => {
  const result = fromResponse(response({
    output: [{
      type: 'reasoning', id: 'rs_1',
      summary: [
        { type: 'summary_text', text: 'Checking ' },
        { type: 'summary_text', text: 'the weather.' },
      ],
    }],
  }))

  const message = result.choices[0].message as { reasoning_content?: string }
  expect(message.reasoning_content).toBe('Checking the weather.')
})

test('raw reasoning text is used when no summary was produced', () => {
  const result = fromResponse(response({
    output: [{
      type: 'reasoning', id: 'rs_1', summary: [],
      content: [{ type: 'reasoning_text', text: 'step one' }],
    }],
  }))

  expect((result.choices[0].message as { reasoning_content?: string }).reasoning_content)
    .toBe('step one')
})

test('a refusal part lands on the message refusal', () => {
  const result = fromResponse(response({
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
    }],
  }))

  expect(result.choices[0].message.refusal).toBe('I cannot help with that.')
  expect(result.choices[0].message.content).toBeNull()
})

test('hosted tool items are ignored rather than breaking the translation', () => {
  const result = fromResponse(response({
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      {
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ],
  }))

  expect(result.choices[0].message.content).toBe('done')
})

test('an incomplete response truncated by the token cap finishes as length', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete',
      content: [{ type: 'output_text', text: 'half', annotations: [] }],
    }],
  }))

  expect(result.choices[0].finish_reason).toBe('length')
})

test('an incomplete response stopped by a filter finishes as content_filter', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'content_filter' },
  }))

  expect(result.choices[0].finish_reason).toBe('content_filter')
})

test('tool calls win over an incomplete reason when deriving finish_reason', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'f', arguments: '{}', status: 'completed',
    }],
  }))

  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('usage maps across, including reasoning and cached tokens', () => {
  const result = fromResponse(response({ usage }))

  expect(result.usage).toEqual({
    prompt_tokens: 40,
    completion_tokens: 12,
    total_tokens: 52,
    completion_tokens_details: { reasoning_tokens: 6 },
    prompt_tokens_details: { cached_tokens: 8 },
  })
})

test('an empty output produces one choice with null content', () => {
  const result = fromResponse(response())
  expect(result.choices[0].message.content).toBeNull()
  expect(result.choices[0].index).toBe(0)
})

async function collectStream(
  events: unknown[],
  req: ChatCompletionRequest = request({ stream: true }),
): Promise<ChatCompletionChunk[]> {
  async function* source() {
    for (const event of events) yield event
  }
  const out: ChatCompletionChunk[] = []
  for await (const chunk of fromResponseStream(source() as never, req)) out.push(chunk)
  return out
}

test('the done events are ignored, so no content is duplicated', async () => {
  const chunks = await collectStream(streamFixture)

  const reasoning = chunks
    .map((c) => (c.choices[0]?.delta as { reasoning_content?: string })?.reasoning_content ?? '')
    .join('')
  expect(reasoning).toBe('Checking the weather.')

  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')
  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('the assistant role appears exactly once, on the first emitted chunk', async () => {
  const chunks = await collectStream(streamFixture)

  const withRole = chunks.filter((c) => c.choices[0]?.delta?.role !== undefined)
  expect(withRole).toHaveLength(1)
  expect(chunks[0].choices[0].delta.role).toBe('assistant')
  // Held rather than emitted at response.created: the first chunk must carry
  // real content, because that pull is the failover boundary.
  expect(
    (chunks[0].choices[0].delta as { reasoning_content?: string }).reasoning_content,
  ).toBe('Checking ')
})

test('tool call indices are dense even though output_index is not', async () => {
  const chunks = await collectStream(streamFixture)
  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])

  // The function call sits at output_index 1, behind a reasoning item.
  expect(fragments.every((fragment) => fragment.index === 0)).toBe(true)
})

test('the tool call id and name arrive on the opening fragment only', async () => {
  const chunks = await collectStream(streamFixture)
  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])

  expect(fragments[0].id).toBe('call_1')
  expect(fragments[0].function?.name).toBe('get_weather')
  expect(fragments.slice(1).every((fragment) => fragment.id === undefined)).toBe(true)
})

test('two function calls get distinct dense indices', async () => {
  const chunks = await collectStream([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs', type: 'reasoning', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'a', type: 'function_call', call_id: 'call_a', name: 'a', arguments: '' } },
    { type: 'response.output_item.added', output_index: 2, item: { id: 'b', type: 'function_call', call_id: 'call_b', name: 'b', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'b', delta: '{}' },
    { type: 'response.completed', response: { id: 'r', created_at: 1, model: 'm', status: 'completed', incomplete_details: null, output: [] } },
  ])

  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
  expect(fragments.map((fragment) => fragment.index)).toEqual([0, 1, 1])
})

test('the finish reason precedes the usage chunk', async () => {
  const chunks = await collectStream(streamFixture)

  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls')
  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
  expect(chunks.at(-1)?.choices).toEqual([])
})

test('the usage chunk is omitted when the client opted out', async () => {
  const chunks = await collectStream(
    streamFixture,
    request({ stream: true, stream_options: { include_usage: false } }),
  )

  expect(chunks.at(-1)?.usage).toBeUndefined()
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls')
})

test('chunks carry the model and creation time from response.created', async () => {
  const chunks = await collectStream(streamFixture)
  expect(chunks[0].model).toBe('gpt-5-mini')
  expect(chunks[0].created).toBe(1700000000)
})

test('output text deltas become content deltas', async () => {
  const chunks = await collectStream([
    { type: 'response.created', response: { id: 'r', created_at: 1, model: 'm', status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'Hello' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'm1', text: 'Hello' },
    { type: 'response.completed', response: { id: 'r', created_at: 1, model: 'm', status: 'completed', incomplete_details: null, output: [] } },
  ])

  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
  expect(text).toBe('Hello')
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop')
})

test('an incomplete response finishes as length', async () => {
  const chunks = await collectStream([
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'half' },
    { type: 'response.incomplete', response: { id: 'r', created_at: 1, model: 'm', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } },
  ])

  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('length')
})

test('a failed response throws so the routing loop can classify it', async () => {
  await expect(
    collectStream([
      { type: 'response.failed', response: { id: 'r', created_at: 1, model: 'm', status: 'failed', error: { code: 'server_error', message: 'upstream exploded' }, output: [] } },
    ]),
  ).rejects.toThrow('upstream exploded')
})
