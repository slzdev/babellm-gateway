import { expect, test } from 'vitest'
import {
  parseProviderConfig, parseRegistryNamespace, readRegistryNamespace,
} from '@/lib/catalog/config'

test('a blank namespace means "no namespace"', () => {
  expect(parseRegistryNamespace('')).toBeNull()
  expect(parseRegistryNamespace('   ')).toBeNull()
})

test('a namespace is trimmed before it is stored', () => {
  expect(parseRegistryNamespace('  xai  ')).toBe('xai')
})

test('a namespace carrying a slash is rejected rather than silently unmatchable', () => {
  expect(() => parseRegistryNamespace('xai/')).toThrow(/single models\.dev provider slug/)
  expect(() => parseRegistryNamespace('anyapi/xai')).toThrow()
})

test('a namespace carrying whitespace is rejected', () => {
  expect(() => parseRegistryNamespace('amazon bedrock')).toThrow()
})

test('readRegistryNamespace reads the key out of a stored config', () => {
  expect(readRegistryNamespace('{"registryNamespace":"xai"}')).toBe('xai')
  expect(readRegistryNamespace('{}')).toBeNull()
  expect(readRegistryNamespace('not json at all')).toBeNull()
  expect(readRegistryNamespace('{"registryNamespace":42}')).toBeNull()
})

test('a config body that is not an object reads as empty', () => {
  expect(parseProviderConfig('null')).toEqual({})
  expect(parseProviderConfig('3')).toEqual({})
  expect(parseProviderConfig('{"timeoutMs":1000}')).toEqual({ timeoutMs: 1000 })
  expect(readRegistryNamespace('[]')).toBeNull()
})
