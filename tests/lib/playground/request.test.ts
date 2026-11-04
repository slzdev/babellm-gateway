import { describe, expect, it } from 'vitest'
import { buildPlaygroundRequest, type PlaygroundTurn } from '@/lib/playground/request'

const settings = {
  model: 'smart', apiKey: ' sk-bab-test ', systemPrompt: '',
  temperature: '', maxCompletionTokens: '', stream: true,
}

const turn = (status: PlaygroundTurn['status'], prompt: string, content: string): PlaygroundTurn => ({
  id: prompt, status, prompt, content, reasoning: '',
})

describe('Playground requests', () => {
  it('omits blank optional settings and requests streamed usage', () => {
    expect(buildPlaygroundRequest(settings, [], 'Hello')).toEqual({
      apiKey: 'sk-bab-test',
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

  it.each([
    { ...settings, apiKey: ' ' }, { ...settings, model: '' },
  ])('rejects requests missing credentials or a model', (invalid) => {
    expect(() => buildPlaygroundRequest(invalid, [], 'Hello')).toThrow()
  })

  it('rejects an empty draft before sending', () => {
    expect(() => buildPlaygroundRequest(settings, [], ' \n')).toThrow(/message/i)
  })
})
