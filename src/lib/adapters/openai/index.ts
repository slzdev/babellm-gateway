import type { ProviderAdapter, ProviderRuntime } from '../types'

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub: Task 7 replaces this body
export function createOpenAIAdapter(_runtime: ProviderRuntime): ProviderAdapter {
  return {
    async chat() {
      throw new Error('not implemented')
    },
    async *chatStream() {
      throw new Error('not implemented')
    },
  }
}
