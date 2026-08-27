import { afterEach, beforeEach, expect, test } from 'vitest'
import { runGatewayRequest } from '@/lib/gateway/handler'
import { transcriptionIngress } from '@/lib/gateway/protocols/transcription'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { MAX_INLINE_BYTES, assertTranscribable } from '@/lib/translate/transcription-to-gemini'
import { fakeAdapterDeps, seedGateway } from '../helpers/gateway'
import { waitForLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

/**
 * What a client sees when *nothing* in the chain can serve its request.
 *
 * `supports` steers the chain; it never refuses one, so an all-ineligible
 * chain falls back to the unfiltered candidates and the answer comes from the
 * adapter. This file drives that path with the real ingress and the real
 * `assertTranscribable`, and asserts the whole client-visible envelope —
 * status, code, message *and* `param` — because `param` is the machine-readable
 * half of a refusal about one named field, and it used to be dropped by the
 * routing loop's classifier on its way out.
 *
 * The endpoint's own end-to-end coverage (formats, failover, logging, capture)
 * is Task 9's; this file is only about the refusals.
 */

function audioFile(bytes = 1024, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

function transcriptionRequest(apiKey: string, fields: Record<string, string | File>) {
  const form = new FormData()
  form.set('file', audioFile())
  form.set('model', 'house-model')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return new Request('http://gateway.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  })
}

/** The real refusal, from the real translator, behind a stubbed client. */
const geminiDeps = fakeAdapterDeps({
  transcribe: async (req) => {
    assertTranscribable(req, 'gemini-only')
    return { text: 'never reached' }
  },
})

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

// Every request here writes a log row, and the handler deliberately does not
// await that write. Letting it land before the next test's resetDb truncates
// the key it references is what keeps the run's output clean — an unawaited
// write into a truncated table surfaces as a foreign-key error on stderr.
afterEach(async () => {
  await waitForLogs()
})

test('a Gemini-only model asked for srt answers a 400 naming response_format', async () => {
  const { apiKey } = await seedGateway({ adapter: 'gemini' })

  const response = await runGatewayRequest(
    transcriptionRequest(apiKey, { response_format: 'srt' }),
    transcriptionIngress,
    geminiDeps,
  )

  expect(response.status).toBe(400)
  const payload = await response.json()
  // Not a 501 "no target can serve this endpoint": this target serves the
  // endpoint fine in json and text, and the client's request is one field away
  // from working — so it is told which field, and what to change it to.
  expect(payload.error).toEqual({
    message: expect.stringContaining('gemini-only'),
    type: 'invalid_request_error',
    code: 'unsupported_parameter',
    param: 'response_format',
  })
  expect(payload.error.message).toContain('srt')
})

test('a Gemini-only model handed oversized audio answers a 400 naming file', async () => {
  const { apiKey } = await seedGateway({ adapter: 'gemini' })

  const response = await runGatewayRequest(
    transcriptionRequest(apiKey, { file: audioFile(MAX_INLINE_BYTES + 1) }),
    transcriptionIngress,
    geminiDeps,
  )

  expect(response.status).toBe(400)
  const payload = await response.json()
  expect(payload.error).toEqual({
    message: expect.stringContaining('20 MB'),
    type: 'invalid_request_error',
    code: 'file_too_large',
    param: 'file',
  })
})

test('an OpenAI-shaped model serves the same request the Gemini one refused', async () => {
  // The control: neither refusal is the ingress being strict about `srt`. The
  // filter and the refusal are both about what one target can do.
  const { apiKey } = await seedGateway({ adapter: 'openai' })

  const response = await runGatewayRequest(
    transcriptionRequest(apiKey, { response_format: 'srt' }),
    transcriptionIngress,
    fakeAdapterDeps({ transcribe: async () => '1\n00:00:00,000 --> 00:00:01,000\nhi\n' }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
})
