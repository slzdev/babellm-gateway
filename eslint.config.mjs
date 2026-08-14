import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output of `pnpm dev:test-db`. Not covered by the `.next/**`
    // default, so without this every browser check leaves thousands of lint
    // errors in generated code behind.
    ".next-test/**",
    // Checkouts of this same repo. Their sources would be linted a second
    // time, against whatever rules this branch happens to have.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
