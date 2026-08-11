import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup/env.ts'],
    globalSetup: ['./tests/setup/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
})
