# Multi-stage build. Deliberately not using Next's `standalone` output: the
# migration entrypoint (scripts/migrate.mjs) is not part of Next's build
# graph, so its dependencies (pg, drizzle-orm) would not be traced into a
# standalone bundle. A plain build stage plus a runtime stage with real
# `node_modules` is bigger but is what actually works end to end.

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---- dependencies for building (dev + prod) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- production-only dependencies for the runtime image ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- build the Next.js app ----
FROM deps AS build
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY package.json next.config.ts ./

EXPOSE 3000

# Migrate first so the server never comes up against an out-of-date schema,
# then start it. Both dependencies (pg, drizzle-orm) are production
# dependencies, so this works with the pruned node_modules above.
CMD ["sh", "-c", "node scripts/migrate.mjs && node_modules/.bin/next start -p ${PORT}"]
