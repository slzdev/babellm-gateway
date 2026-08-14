import { expect, test } from 'vitest'
import { toContents } from '@/lib/translate/chat-to-gemini'
import { ProviderError } from '@/lib/gateway/errors'
import type { ChatMessage } from '@/lib/schemas/chat'

test('a plain exchange becomes alternating user and model turns', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
    { role: 'user', parts: [{ text: 'again' }] },
  ])
})

test('system and developer turns are hoisted into the system instruction', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'developer', content: 'no emoji' },
  ]
  const { contents, systemInstruction } = toContents(messages)

  expect(systemInstruction).toBe('be terse\n\nno emoji')
  expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
})

test('adjacent same-role turns are merged into one content', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
  ]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: 'one' }, { text: 'two' }] },
  ])
})

test('assistant tool calls become functionCall parts with parsed arguments', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    },
  ]
  expect(toContents(messages).contents[1]).toEqual({
    role: 'model',
    parts: [{ functionCall: { id: 'call_a', name: 'get_weather', args: { city: 'Paris' } } }],
  })
})

test('unparseable tool call arguments degrade to an empty object', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: 'not json' } }],
    },
  ]
  expect(toContents(messages).contents[0].parts?.[0])
    .toEqual({ functionCall: { id: 'call_a', name: 'f', args: {} } })
})

test('a tool result is correlated to its call name through the conversation', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: '{"temp":21}' },
  ]
  expect(toContents(messages).contents[1]).toEqual({
    role: 'user',
    parts: [{ functionResponse: { id: 'call_a', name: 'get_weather', response: { temp: 21 } } }],
  })
})

test('a non-JSON tool result is wrapped under an output key', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'sunny' },
  ]
  expect(toContents(messages).contents[1].parts?.[0])
    .toEqual({ functionResponse: { id: 'call_a', name: 'f', response: { output: 'sunny' } } })
})

test('a tool result whose call id matches nothing is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'call_missing', content: 'sunny' }]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('a tool result with no call id at all is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', content: 'sunny' }]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('the legacy function role maps to a real functionResponse via its name', () => {
  const messages: ChatMessage[] = [{ role: 'function', name: 'get_weather', content: '{"temp":21}' }]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
  ])
})

test('an image part becomes a fileData part carrying the caller url', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ]
  expect(toContents(messages).contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'what is this' },
        { fileData: { fileUri: 'https://example.com/cat.png', mimeType: 'image/png' } },
      ],
    },
  ])
})

test('a video part becomes a fileData part carrying the caller url', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what happens here' },
        { type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } },
      ],
    },
  ]
  expect(toContents(messages).contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'what happens here' },
        { fileData: { fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' } },
      ],
    },
  ])
})

test('a mime_type on the part is honoured for an untypeable url', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'video_url',
          video_url: { url: 'https://cdn.example.com/v/9f2b', mime_type: 'video/webm' },
        },
      ],
    },
  ]
  expect(toContents(messages).contents[0].parts).toEqual([
    { fileData: { fileUri: 'https://cdn.example.com/v/9f2b', mimeType: 'video/webm' } },
  ])
})

test('a media url that cannot be typed fails the request rather than being dropped', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/asset/9f2b' } },
      ],
    },
  ]
  expect(() => toContents(messages)).toThrow(ProviderError)
})

test('a part type naming an Object prototype key is skipped, not treated as media', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'constructor' },
        { type: 'toString' },
      ],
    },
  ]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: 'hi' }] },
  ])
})

test('a media part carrying no url is a 400 rather than a crash', () => {
  const messages = [
    { role: 'user', content: [{ type: 'video_url', video_url: {} }] },
  ] as unknown as ChatMessage[]

  expect(() => toContents(messages)).toThrow(ProviderError)
})

test('an audio part is still skipped rather than failing the request', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'transcribe' },
        { type: 'input_audio', input_audio: { data: 'AQID', format: 'wav' } },
      ],
    },
  ]
  expect(toContents(messages).contents).toEqual([
    { role: 'user', parts: [{ text: 'transcribe' }] },
  ])
})

test('an empty message contributes no content at all', () => {
  expect(toContents([{ role: 'assistant', content: '' }]).contents).toEqual([])
})
