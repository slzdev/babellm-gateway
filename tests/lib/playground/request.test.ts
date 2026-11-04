import { describe, expect, it } from 'vitest'
import { buildPlaygroundRequest, type PlaygroundTurn } from '@/lib/playground/request'

const settings = {
  model: 'smart', apiKeyId: ' 11111111-1111-4111-8111-111111111111 ', systemPrompt: '',
  temperature: '', maxCompletionTokens: '', stream: true,
}

const turn = (status: PlaygroundTurn['status'], prompt: string, content: string): PlaygroundTurn => ({
  id: prompt, status, prompt, content, reasoning: '',
})

describe('Playground requests', () => {
  it('omits blank optional settings and requests streamed usage', () => {
    expect(buildPlaygroundRequest(settings, [], 'Hello')).toEqual({
      apiKeyId: '11111111-1111-4111-8111-111111111111',
      body: {
        model: 'smart', messages: [{ role: 'user', content: 'Hello' }],
        stream: true, stream_options: { include_usage: true },
      },
    })
  })

  it('sends explicit numeric settings including temperature zero with the completion token field', () => {
    expect(buildPlaygroundRequest({
      ...settings, temperature: '0', maxCompletionTokens: ' 128 ', stream: false,
    }, [], 'Hello').body).toEqual({
      model: 'smart', messages: [{ role: 'user', content: 'Hello' }],
      stream: false, temperature: 0, max_completion_tokens: 128,
    })
  })

  it('places a system prompt before completed multi-turn context', () => {
    expect(buildPlaygroundRequest({ ...settings, systemPrompt: 'Be concise.' }, [
      turn('complete', 'First', 'First answer'), turn('complete', 'Second', 'Second answer'),
    ], 'Third').body.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'First' }, { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second' }, { role: 'assistant', content: 'Second answer' },
      { role: 'user', content: 'Third' },
    ])
  })

  it('excludes both sides of failed, stopped and pending turns when retrying the retained draft', () => {
    expect(buildPlaygroundRequest(settings, [
      turn('complete', 'First', 'Answer'), turn('failed', 'Failed', 'Partial'),
      turn('stopped', 'Stopped', 'Partial'), turn('pending', 'Retry this', ''),
    ], 'Retry this').body.messages).toEqual([
      { role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Retry this' },
    ])
  })

  it('omits whitespace-only system and optional numeric inputs without altering message text', () => {
    expect(buildPlaygroundRequest({
      ...settings, systemPrompt: '  ', temperature: ' ', maxCompletionTokens: ' ',
    }, [], '  Keep whitespace\n').body).toEqual({
      model: 'smart', messages: [{ role: 'user', content: '  Keep whitespace\n' }],
      stream: true, stream_options: { include_usage: true },
    })
  })

  it.each(['-0.1', '2.1', 'NaN', 'Infinity', 'abc'])('rejects invalid temperature %s', (temperature) => {
    expect(() => buildPlaygroundRequest({ ...settings, temperature }, [], 'Hello')).toThrow(/temperature/i)
  })

  it.each(['0', '-1', '1.5', 'Infinity', 'abc', '9007199254740992'])('rejects invalid token cap %s', (maxCompletionTokens) => {
    expect(() => buildPlaygroundRequest({ ...settings, maxCompletionTokens }, [], 'Hello')).toThrow(/tokens/i)
  })

  it.each(['', '   '])('rejects a missing key selection %j', (apiKeyId) => {
    expect(() => buildPlaygroundRequest({ ...settings, apiKeyId }, [], 'Hello')).toThrow(/select.*api key/i)
  })

  it('uses the selected key ID without changing the chat payload', () => {
    const selected = buildPlaygroundRequest({
      ...settings, apiKeyId: '22222222-2222-4222-8222-222222222222', stream: false,
    }, [turn('complete', 'First', 'Answer')], 'Follow up')
    expect(selected).toEqual({
      apiKeyId: '22222222-2222-4222-8222-222222222222',
      body: {
        model: 'smart', stream: false, messages: [
          { role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'Follow up' },
        ],
      },
    })
  })

  it('rejects a missing model', () => {
    expect(() => buildPlaygroundRequest({ ...settings, model: '' }, [], 'Hello')).toThrow(/model/i)
  })

  it('rejects an empty draft before sending', () => {
    expect(() => buildPlaygroundRequest(settings, [], ' \n')).toThrow(/message/i)
  })
})
