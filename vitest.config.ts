import { configDefaults, defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // A git worktree of this repo lives inside it, and its tests/ directory
    // globs as readily as this checkout's. Running another branch's suite
    // against this branch's source fails in ways that say nothing about
    // either. Spread the defaults back in — this replaces them, not adds.
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
    setupFiles: ['./tests/setup/env.ts'],
    globalSetup: ['./tests/setup/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
    // Test files share one real Postgres database and reset it via
    // TRUNCATE in tests/helpers/db.ts. Running files in parallel lets one
    // file's reset/insert race another file's in-flight test on a shared
    // table (e.g. api_keys), causing flaky failures. Serialize file
    // execution so the shared-DB fixture stays isolated.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
})
