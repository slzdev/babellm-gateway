import { expect, test } from 'vitest'
import { bedrockReasoning } from '@/lib/translate/bedrock-reasoning'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { ProviderConfig } from '@/lib/adapters/types'

const base: ChatCompletionRequest = { model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }
const r = (extra: Partial<ChatCompletionRequest>, model: string, config?: ProviderConfig) =>
  bedrockReasoning({ ...base, ...extra }, model, config)

// Narrow view of the loosely typed `fields` bag for nested assertions.
const at = (fields: Record<string, unknown> | undefined) => fields as Record<string, Record<string, unknown>>

const ADAPTIVE = { thinking: { type: 'adaptive', display: 'summarized' } }

test('claude adaptive', () => {
  const out = r({ reasoning_effort: 'high' }, 'anthropic.claude-sonnet-5-5')
  expect(out).toEqual({
    fields: { ...ADAPTIVE, output_config: { effort: 'high' } },
    translated: true,
  })
  expect(out.maxTokens).toBeUndefined()
})

test('claude new model works unlisted', () => {
  expect(r({ reasoning_effort: 'low' }, 'us.anthropic.claude-opus-9-0-v1:0').fields)
    .toEqual({ ...ADAPTIVE, output_config: { effort: 'low' } })
})

test('minimal aliases to low for claude', () => {
  const fields = at(r({ reasoning_effort: 'minimal' }, 'anthropic.claude-sonnet-5-5').fields)
  expect(fields.output_config.effort).toBe('low')
})

test('claude legacy budget', () => {
  expect(r({ reasoning_effort: 'medium' }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toEqual({
    fields: { thinking: { type: 'enabled', budget_tokens: 8192 } },
    maxTokens: 12288,
    translated: true,
  })
})

test('legacy ids', () => {
  for (const id of [
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-opus-4-20250514-v1:0',
    'anthropic.claude-opus-4-1-20250805-v1:0',
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-opus-4-5-20251101-v1:0',
  ]) {
    expect(at(r({ reasoning_effort: 'low' }, id).fields).thinking.type, id).toBe('enabled')
  }
  for (const id of ['anthropic.claude-opus-4-6-v1', 'anthropic.claude-sonnet-4-6']) {
    expect(at(r({ reasoning_effort: 'low' }, id).fields).thinking.type, id).toBe('adaptive')
  }
})

test('legacy xhigh uses high budget', () => {
  const out = r({ reasoning_effort: 'xhigh' }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(at(out.fields).thinking.budget_tokens).toBe(16384)
})

test('legacy clamps to client max', () => {
  const out = r({ reasoning_effort: 'high', max_tokens: 5000 }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(at(out.fields).thinking.budget_tokens).toBe(4999)
  expect(out.maxTokens).toBeUndefined()
})

test('max_completion_tokens takes precedence over max_tokens', () => {
  const out = r({ reasoning_effort: 'high', max_tokens: 100000, max_completion_tokens: 5000 }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(at(out.fields).thinking.budget_tokens).toBe(4999)
})

test('legacy too small to think', () => {
  const out = r({ reasoning_effort: 'high', max_tokens: 1000 }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(out.fields).toBeUndefined()
  expect(out.translated).toBe(false)
})

test('claude 3.5 unsupported', () => {
  expect(r({ reasoning_effort: 'high' }, 'anthropic.claude-3-5-sonnet-20241022-v2:0')).toEqual({ translated: false })
})

test('openai', () => {
  expect(r({ reasoning_effort: 'xhigh' }, 'global.openai.gpt-6.2-sol')).toEqual({
    fields: { reasoning: { effort: 'xhigh', summary: 'auto' } },
    translated: true,
  })
  expect(at(r({ reasoning_effort: 'minimal' }, 'global.openai.gpt-6.2-sol').fields).reasoning.effort).toBe('minimal')
})

test('ARN', () => {
  expect(r({ reasoning_effort: 'low' }, 'arn:aws:bedrock:us-east-1:1:inference-profile/us.openai.gpt-oss-120b-1:0').fields)
    .toEqual({ reasoning: { effort: 'low', summary: 'auto' } })
})

test('none sends nothing', () => {
  for (const model of ['anthropic.claude-sonnet-5-5', 'openai.gpt-6.2-sol']) {
    expect(r({ reasoning_effort: 'none' }, model)).toEqual({ translated: false })
    expect(r({ reasoning_effort: 'none' }, model, { requestReasoningSummary: true })).toEqual({ translated: false })
  }
})

test('opt-in without effort', () => {
  const config = { requestReasoningSummary: true }
  expect(r({}, 'anthropic.claude-sonnet-5-5', config)).toEqual({ fields: ADAPTIVE, translated: false })
  expect(r({}, 'anthropic.claude-sonnet-4-5-20250929-v1:0', config)).toEqual({
    fields: { thinking: { type: 'enabled', budget_tokens: 8192 } },
    maxTokens: 12288,
    translated: false,
  })
  expect(r({}, 'openai.gpt-6.2-sol', config)).toEqual({ fields: { reasoning: { summary: 'auto' } }, translated: false })
})

test('unsupported family', () => {
  expect(r({ reasoning_effort: 'high' }, 'meta.llama4-maverick-17b-instruct-v1:0')).toEqual({ translated: false })
  expect(r({ reasoning_effort: 'high' }, 'arn:aws:bedrock:us-east-1:1:application-inference-profile/abc123')).toEqual({ translated: false })
})

test('claude 2 and instant unsupported', () => {
  for (const id of ['anthropic.claude-v2:1', 'anthropic.claude-v2', 'anthropic.claude-instant-v1']) {
    expect(r({ reasoning_effort: 'high' }, id), id).toEqual({ translated: false })
  }
})

test('effort names that collide with Object.prototype are treated as plain strings', () => {
  const legacy = r({ reasoning_effort: 'constructor' }, 'anthropic.claude-sonnet-4-5-20250929-v1:0')
  expect(at(legacy.fields).thinking.budget_tokens).toBe(16384)
  const adaptive = r({ reasoning_effort: 'constructor' }, 'anthropic.claude-sonnet-5-5')
  expect(at(adaptive.fields).output_config.effort).toBe('constructor')
})

const LEGACY = 'anthropic.claude-sonnet-4-5-20250929-v1:0'
const call = { id: 'c1', type: 'function' as const, function: { name: 'weather', arguments: '{}' } }
const loop: ChatCompletionRequest['messages'] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, tool_calls: [call] },
  { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
]

test('legacy budget thinking is skipped while a tool loop is in flight', () => {
  expect(r({ reasoning_effort: 'high', messages: loop }, LEGACY)).toEqual({ translated: false })
  // The provider opt-in path is guarded the same way.
  expect(r({ messages: loop }, LEGACY, { requestReasoningSummary: true })).toEqual({ translated: false })
})

test('legacy budget thinking is sent once a new user turn follows the tool result', () => {
  const messages = [...loop, { role: 'user' as const, content: 'thanks' }]
  expect(at(r({ reasoning_effort: 'high', messages }, LEGACY).fields).thinking.budget_tokens).toBe(16384)
})

test('adaptive claude is unchanged in a tool loop', () => {
  expect(r({ reasoning_effort: 'high', messages: loop }, 'anthropic.claude-sonnet-5-5')).toEqual({
    fields: { ...ADAPTIVE, output_config: { effort: 'high' } },
    translated: true,
  })
})

test('hyphenated geo prefixes are stripped', () => {
  expect(at(r({ reasoning_effort: 'low' }, 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0').fields).thinking.type).toBe('enabled')
  expect(r({ reasoning_effort: 'low' }, 'us-gov.openai.gpt-6.2-sol').fields)
    .toEqual({ reasoning: { effort: 'low', summary: 'auto' } })
})

test('legacy max_tokens equal to the budget leaves one token of room', () => {
  const out = r({ reasoning_effort: 'medium', max_tokens: 8192 }, LEGACY)
  expect(at(out.fields).thinking.budget_tokens).toBe(8191)
  expect(out.maxTokens).toBeUndefined()
})
