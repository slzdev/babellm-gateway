import { expect, test, vi } from 'vitest'
import { imageUrls, resolveMedia, type MediaDeps } from '@/lib/adapters/gemini/media'
import type { ChatMessage } from '@/lib/schemas/chat'

function imageMessage(...urls: string[]): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ],
  }
}

function imageResponse(body: Uint8Array, type = 'image/png') {
  return new Response(body as BodyInit, { status: 200, headers: { 'content-type': type } })
}

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    client: { files: { upload: vi.fn().mockResolvedValue({ uri: 'files/abc', mimeType: 'image/png' }) } } as never,
    signal: new AbortController().signal,
    requestId: 'req_1',
    fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3]))),
    ...overrides,
  }
}

test('image urls are collected once each, in order', () => {
  const messages = [imageMessage('a', 'b'), imageMessage('a')]
  expect(imageUrls(messages)).toEqual(['a', 'b'])
})

test('a message with no array content contributes no urls', () => {
  expect(imageUrls([{ role: 'user', content: 'hi' }])).toEqual([])
})

test('a base64 data uri becomes inline data with no network call', async () => {
  const d = deps()
  const resolved = await resolveMedia([imageMessage('data:image/png;base64,AQID')], d)

  expect(resolved.get('data:image/png;base64,AQID'))
    .toEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } })
  expect(d.fetchImpl).not.toHaveBeenCalled()
})

test('a well-formed non-base64 data uri decodes to inline base64 data', async () => {
  const d = deps()
  const resolved = await resolveMedia([imageMessage('data:text/plain,hello')], d)

  expect(resolved.get('data:text/plain,hello'))
    .toEqual({ inlineData: { mimeType: 'text/plain', data: 'aGVsbG8=' } })
  expect(d.fetchImpl).not.toHaveBeenCalled()
})

test('a malformed non-base64 data uri is dropped and warns rather than throwing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps()

  const resolved = await resolveMedia([imageMessage('data:image/png,%89PNG')], d)

  expect(resolved.size).toBe(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('req_1'))
  warn.mockRestore()
})

test('a files api url passes straight through as file data', async () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/files/abc'
  const d = deps()
  const resolved = await resolveMedia([imageMessage(url)], d)

  expect(resolved.get(url)).toEqual({ fileData: { fileUri: url } })
  expect(d.fetchImpl).not.toHaveBeenCalled()
})

test('a gs uri passes straight through as file data', async () => {
  const d = deps()
  const resolved = await resolveMedia([imageMessage('gs://bucket/cat.png')], d)
  expect(resolved.get('gs://bucket/cat.png')).toEqual({ fileData: { fileUri: 'gs://bucket/cat.png' } })
})

test('an https image is fetched, uploaded, and referenced by its uri', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/xyz', mimeType: 'image/png' })
  const d = deps({ client: { files: { upload } } as never })
  const resolved = await resolveMedia([imageMessage('https://example.com/cat.png')], d)

  expect(d.fetchImpl).toHaveBeenCalledWith(
    'https://example.com/cat.png',
    expect.objectContaining({ signal: d.signal }),
  )
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ mimeType: 'image/png', abortSignal: d.signal }),
  }))
  expect(resolved.get('https://example.com/cat.png'))
    .toEqual({ fileData: { fileUri: 'files/xyz', mimeType: 'image/png' } })
})

test('the same url is fetched and uploaded only once', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/xyz', mimeType: 'image/png' })
  const d = deps({ client: { files: { upload } } as never })
  await resolveMedia([imageMessage('https://example.com/cat.png', 'https://example.com/cat.png')], d)

  expect(d.fetchImpl).toHaveBeenCalledTimes(1)
  expect(upload).toHaveBeenCalledTimes(1)
})

test('a failed fetch drops the image and warns rather than throwing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({ fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 404 })) })

  const resolved = await resolveMedia([imageMessage('https://example.com/gone.png')], d)

  expect(resolved.size).toBe(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('req_1'))
  warn.mockRestore()
})

test('a non-image response is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({
    fetchImpl: vi.fn().mockResolvedValue(
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ),
  })

  expect((await resolveMedia([imageMessage('https://example.com/page')], d)).size).toBe(0)
  warn.mockRestore()
})

test('an image over the byte cap is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({
    maxBytes: 2,
    fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3, 4]))),
  })

  expect((await resolveMedia([imageMessage('https://example.com/big.png')], d)).size).toBe(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('byte'))
  warn.mockRestore()
})

test('an upload that returns no uri is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({ client: { files: { upload: vi.fn().mockResolvedValue({}) } } as never })

  expect((await resolveMedia([imageMessage('https://example.com/cat.png')], d)).size).toBe(0)
  warn.mockRestore()
})

test('a request with no images does no work at all', async () => {
  const d = deps()
  expect((await resolveMedia([{ role: 'user', content: 'hi' }], d)).size).toBe(0)
  expect(d.fetchImpl).not.toHaveBeenCalled()
})
