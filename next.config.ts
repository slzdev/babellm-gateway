import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` takes an exclusive lock on `<distDir>/dev/lock`, so a second
  // dev server in this checkout exits with "Another next dev server is
  // already running" no matter which port it was given. `pnpm dev:test-db`
  // sets NEXT_DIST_DIR so a browser check can run alongside a developer's
  // `pnpm dev` instead of demanding they stop it. Unset everywhere else, so
  // builds and production are untouched.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
