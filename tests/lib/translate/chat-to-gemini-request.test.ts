import { expect, test } from 'vitest'
import { toContents, type MediaParts } from '@/lib/translate/chat-to-gemini'
import type { ChatMessage } from '@/lib/schemas/chat'

const noMedia: MediaParts = new Map()

test('a plain exchange becomes alternating user and model turns', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
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
  const { contents, systemInstruction } = toContents(messages, noMedia)

  expect(systemInstruction).toBe('be terse\n\nno emoji')
  expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
})

test('adjacent same-role turns are merged into one content', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
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
  expect(toContents(messages, noMedia).contents[1]).toEqual({
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
  expect(toContents(messages, noMedia).contents[0].parts?.[0])
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
  expect(toContents(messages, noMedia).contents[1]).toEqual({
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
  expect(toContents(messages, noMedia).contents[1].parts?.[0])
    .toEqual({ functionResponse: { id: 'call_a', name: 'f', response: { output: 'sunny' } } })
})

test('a tool result whose call id matches nothing is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'call_missing', content: 'sunny' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('a tool result with no call id at all is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', content: 'sunny' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('the legacy function role maps to a real functionResponse via its name', () => {
  const messages: ChatMessage[] = [{ role: 'function', name: 'get_weather', content: '{"temp":21}' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
  ])
})

test('image parts are replaced by their resolved media part', () => {
  const media: MediaParts = new Map([
    ['https://example.com/cat.png', { fileData: { fileUri: 'files/abc', mimeType: 'image/png' } }],
  ])
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ]
  expect(toContents(messages, media).contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'what is this' },
        { fileData: { fileUri: 'files/abc', mimeType: 'image/png' } },
      ],
    },
  ])
})

test('an image that could not be resolved is left out rather than failing', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/gone.png' } },
      ],
    },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: 'what is this' }] },
  ])
})

test('an empty message contributes no content at all', () => {
  expect(toContents([{ role: 'assistant', content: '' }], noMedia).contents).toEqual([])
})
