FROM oven/bun:1.3.14-slim AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

COPY package.json bun.lock ./
# --frozen-lockfile fails the build if bun.lock doesn't match package.json,
# so an image can never be built from an out-of-date dependency graph.
RUN bun install --frozen-lockfile

# Rebuild the source code only when needed.
#
# This stage needs a REAL `node` on PATH. Next 16 builds with Turbopack, whose
# default plugin runtime (experimental.turbopackPluginRuntimeStrategy:
# "childProcesses") evaluates PostCSS/loaders in a pool of child `node`
# processes. The oven/bun images do put a `node` on PATH — but it's
# /usr/local/bun-node-fallback-bin/node, a symlink to bun — so the pool spawns
# Bun, and tearing it down segfaults the build (SIGSEGV, exit 139) *after* it
# has already written complete, correct output. Same crash on alpine and slim,
# baseline and AVX2 builds, any worker count. A real node fixes it.
#
# So: node image as the base with Bun copied in, and `bun run build` as before.
# Node exists only in this throwaway stage — the runtime image below is Bun-only.
# `base` must stay Debian (not alpine) for this COPY: a musl-linked bun binary
# would not run here. Matching trixie keeps them on the same glibc.
FROM node:24-trixie-slim AS builder
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build

# The sidecar is a second entrypoint into the same codebase, so it ships in the
# same image and is selected by `command:` in compose. `--conditions
# react-server` makes the "server-only" package resolve to its empty stub, which
# is what lets this bundle reuse lib/db, lib/secrets and lib/activity verbatim
# instead of carrying a second copy of the data layer.
RUN bun build lib/terminal/main.ts --target=bun --conditions="react-server" \
    --outfile terminal-server.js

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED=1

# Debian's useradd/groupadd — oven/bun:slim has no busybox addgroup/adduser.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public

# The mock-time page reads docs/time-mocking-api.md at runtime via a dynamic
# path. Next's file tracer (Turbopack) doesn't reliably bundle it into the
# standalone output, so copy it explicitly.
COPY --from=builder /app/docs ./docs

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/terminal-server.js ./terminal-server.js

USER nextjs

EXPOSE 3000

ENV PORT=3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/config/next-config-js/output
ENV HOSTNAME="0.0.0.0"
CMD ["bun", "server.js"]
