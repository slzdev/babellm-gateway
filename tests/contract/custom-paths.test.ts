import { expect, test } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderConfig, ProviderRuntime } from '@/lib/adapters/types'

/**
 * The per-endpoint path overrides work by handing the SDK a `path` in its
 * per-request options, which it merges over the one each resource hardcodes.
 * The adapter unit tests pin that the adapters pass it; these pin the half
 * that lives in the SDK — that a passed path actually reaches the wire, and
 * that an absolute one replaces the base URL's own path rather than being
 * appended to it. An SDK upgrade that reordered either would break the
 * feature silently otherwise.
 */

const completion = {
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'clone-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
}

const response = {
  id: 'resp_1', object: 'response', created_at: 1, model: 'clone-model',
  status: 'completed', incomplete_details: null,
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
}

/** A real SDK client whose transport records the URL instead of sending it. */
function recordingRuntime(
  config: ProviderConfig,
  body: unknown,
  baseUrl = 'https://api.example/v1',
) {
  const urls: string[] = []

  const factory = (opts: Record<string, unknown>) => new OpenAI({
    ...opts,
    fetch: (async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch,
  })

  const runtime: ProviderRuntime = {
    id: 'p1',
    name: 'clone',
    adapter: 'openai_compatible',
    baseUrl,
    credentials: { apiKey: 'sk-test' },
    config,
  }

  return { runtime, factory, urls }
}

const ctx = {
  upstreamModel: 'clone-model',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const chatBody = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] }

test('the SDK requests the default chat completions URL when nothing is configured', async () => {
  const { runtime, factory, urls } = recordingRuntime({}, completion)
  await createOpenAIAdapter(runtime, factory as never).chat(chatBody, ctx)

  expect(urls).toEqual(['https://api.example/v1/chat/completions'])
})

test('a configured chat completions path replaces the base URL\'s own path', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { chatCompletionsPath: '/api/v2/chat' },
    completion,
  )
  await createOpenAIAdapter(runtime, factory as never).chat(chatBody, ctx)

  // The base URL's /v1 is gone — a custom path is absolute on the host.
  expect(urls).toEqual(['https://api.example/api/v2/chat'])
})

test('a configured models path replaces the base URL\'s own path', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { modelsPath: '/api/v2/models' },
    { object: 'list', data: [{ id: 'clone-model', object: 'model' }] },
  )
  const models = await createOpenAIAdapter(runtime, factory as never)
    .listModels!({ signal: ctx.signal })

  expect(urls).toEqual(['https://api.example/api/v2/models'])
  expect(models.map((m) => m.id)).toEqual(['clone-model'])
})

test('a configured responses path replaces the base URL\'s own path', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { responsesPath: '/api/v2/responses' },
    response,
  )
  await createResponsesAdapter(runtime, factory as never).chat(chatBody, ctx)

  expect(urls).toEqual(['https://api.example/api/v2/responses'])
})

/**
 * The reported case: a gateway that serves the OpenAI shape from a second
 * mount point, not from under the one its base URL names.
 */
test('a multi-segment base URL prefix is dropped, not carried, by a custom path', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { chatCompletionsPath: '/openai/v1/chat/completions' },
    completion,
    'https://example.com/gwt/v1',
  )
  await createOpenAIAdapter(runtime, factory as never).chat(chatBody, ctx)

  expect(urls).toEqual(['https://example.com/openai/v1/chat/completions'])
})

test('a port and a non-default scheme on the base URL survive a custom path', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { chatCompletionsPath: '/api/v2/chat' },
    completion,
    'http://localhost:11434/v1',
  )
  await createOpenAIAdapter(runtime, factory as never).chat(chatBody, ctx)

  expect(urls).toEqual(['http://localhost:11434/api/v2/chat'])
})
