import { expect, test } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderConfig, ProviderRuntime } from '@/lib/adapters/types'

/**
 * The per-endpoint path overrides work by handing the SDK a `path` in its
 * per-request options, which it merges over the one each resource hardcodes.
 * The adapter unit tests pin that the adapters pass it; these pin the half
 * that lives in the SDK — that a passed path actually reaches the wire, joined
 * onto the base URL rather than replacing it. An SDK upgrade that reorders
 * that merge would break the feature silently otherwise.
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
function recordingRuntime(config: ProviderConfig, body: unknown) {
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
    baseUrl: 'https://api.example/v1',
    credentials: { apiKey: 'sk-test' },
    config,
    apiFlavor: 'chat_completions',
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

test('a configured chat completions path is appended to the base URL', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { chatCompletionsPath: '/api/v2/chat' },
    completion,
  )
  await createOpenAIAdapter(runtime, factory as never).chat(chatBody, ctx)

  // The base URL keeps its own /v1 prefix — the path is joined, not swapped in.
  expect(urls).toEqual(['https://api.example/v1/api/v2/chat'])
})

test('a configured models path is appended to the base URL', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { modelsPath: '/api/v2/models' },
    { object: 'list', data: [{ id: 'clone-model', object: 'model' }] },
  )
  const models = await createOpenAIAdapter(runtime, factory as never)
    .listModels!({ signal: ctx.signal })

  expect(urls).toEqual(['https://api.example/v1/api/v2/models'])
  expect(models.map((m) => m.id)).toEqual(['clone-model'])
})

test('a configured responses path is appended to the base URL', async () => {
  const { runtime, factory, urls } = recordingRuntime(
    { responsesPath: '/api/v2/responses' },
    response,
  )
  await createResponsesAdapter(
    { ...runtime, apiFlavor: 'responses' },
    factory as never,
  ).chat(chatBody, ctx)

  expect(urls).toEqual(['https://api.example/v1/api/v2/responses'])
})
