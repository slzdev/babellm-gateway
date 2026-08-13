import { expect, test } from 'vitest'
import { mediaPart } from '@/lib/adapters/gemini/media'
import { ProviderError } from '@/lib/gateway/errors'

test('an https image url is passed straight through with its mime type', () => {
  expect(mediaPart('https://example.com/cat.png', 'image')).toEqual({
    fileData: { fileUri: 'https://example.com/cat.png', mimeType: 'image/png' },
  })
})

test('an https video url is passed straight through with its mime type', () => {
  expect(mediaPart('https://example.com/clip.mp4', 'video')).toEqual({
    fileData: { fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' },
  })
})

test('a jpg extension maps to the jpeg mime type', () => {
  expect(mediaPart('https://example.com/cat.jpg', 'image')).toEqual({
    fileData: { fileUri: 'https://example.com/cat.jpg', mimeType: 'image/jpeg' },
  })
})

test('a mov extension maps to the quicktime mime type', () => {
  expect(mediaPart('https://example.com/clip.mov', 'video')).toEqual({
    fileData: { fileUri: 'https://example.com/clip.mov', mimeType: 'video/quicktime' },
  })
})

test('an uppercase extension is recognised', () => {
  expect(mediaPart('https://example.com/CAT.PNG', 'image')).toEqual({
    fileData: { fileUri: 'https://example.com/CAT.PNG', mimeType: 'image/png' },
  })
})

test('a pre-signed url keeps its query string but takes its type from the path', () => {
  const url = 'https://bucket.s3.amazonaws.com/cat.jpeg?X-Amz-Signature=abc&X-Amz-Expires=900'
  expect(mediaPart(url, 'image')).toEqual({
    fileData: { fileUri: url, mimeType: 'image/jpeg' },
  })
})

test('a fragment is not mistaken for part of the extension', () => {
  const url = 'https://example.com/clip.webm#t=10'
  expect(mediaPart(url, 'video')).toEqual({
    fileData: { fileUri: url, mimeType: 'video/webm' },
  })
})

test('a caller-supplied mime type wins over the extension', () => {
  expect(mediaPart('https://example.com/cat.png', 'image', 'image/webp')).toEqual({
    fileData: { fileUri: 'https://example.com/cat.png', mimeType: 'image/webp' },
  })
})

test('a caller-supplied mime type resolves an extensionless url', () => {
  expect(mediaPart('https://cdn.example.com/asset/9f2b1c', 'image', 'image/jpeg')).toEqual({
    fileData: { fileUri: 'https://cdn.example.com/asset/9f2b1c', mimeType: 'image/jpeg' },
  })
})

test('an extensionless url with no caller mime type is a non-retryable 400', () => {
  try {
    mediaPart('https://cdn.example.com/asset/9f2b1c', 'image')
    expect.unreachable('expected mediaPart to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ status: 400, retryable: false })
    expect((err as ProviderError).message).toContain('mime_type')
  }
})

test('an unrecognised extension is a non-retryable 400', () => {
  expect(() => mediaPart('https://example.com/cat.tiff', 'image'))
    .toThrow(ProviderError)
})

test('an image url in a video part is refused rather than sent with a wrong type', () => {
  try {
    mediaPart('https://example.com/cat.png', 'video')
    expect.unreachable('expected mediaPart to throw')
  } catch (err) {
    expect(err).toMatchObject({ status: 400, retryable: false })
    expect((err as ProviderError).message).toContain('image/png')
  }
})

test('a caller-supplied mime type that contradicts the part kind is refused', () => {
  expect(() => mediaPart('https://example.com/clip.mp4', 'video', 'image/png'))
    .toThrow(ProviderError)
})

test('the failing url is named in the error so the caller can find it', () => {
  expect(() => mediaPart('https://example.com/cat.tiff', 'image'))
    .toThrow(/cat\.tiff/)
})

test('a query string is not repeated into the error message', () => {
  try {
    mediaPart('https://example.com/asset?token=secret', 'image')
    expect.unreachable('expected mediaPart to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).not.toContain('token=secret')
  }
})

test('a base64 data uri becomes inline data', () => {
  expect(mediaPart('data:image/png;base64,AQID', 'image')).toEqual({
    inlineData: { mimeType: 'image/png', data: 'AQID' },
  })
})

test('a well-formed non-base64 data uri decodes to inline base64 data', () => {
  expect(mediaPart('data:text/plain,hello', 'image')).toEqual({
    inlineData: { mimeType: 'text/plain', data: 'aGVsbG8=' },
  })
})

test('a malformed non-base64 data uri is a non-retryable 400', () => {
  try {
    mediaPart('data:image/png,%89PNG', 'image')
    expect.unreachable('expected mediaPart to throw')
  } catch (err) {
    expect(err).toMatchObject({ status: 400, retryable: false })
  }
})

test('a files api url passes through untouched, carrying its own type', () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/files/abc'
  expect(mediaPart(url, 'image')).toEqual({ fileData: { fileUri: url } })
})

test('a gs uri passes through untouched, carrying its own type', () => {
  expect(mediaPart('gs://bucket/cat.png', 'image')).toEqual({
    fileData: { fileUri: 'gs://bucket/cat.png' },
  })
})

test('a caller mime type is still forwarded alongside a files api url', () => {
  const url = 'gs://bucket/opaque-object'
  expect(mediaPart(url, 'video', 'video/mp4')).toEqual({
    fileData: { fileUri: url, mimeType: 'video/mp4' },
  })
})
