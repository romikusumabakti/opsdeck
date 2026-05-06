# syntax=docker.io/docker/dockerfile:1

# Pinned to Bun 1.2.x as a workaround for a known regression in 1.3.6+ where
# the baseline binary still emits AVX instructions and crashes with SIGILL on
# CPUs without AVX support (our Jenkins build host).
# Tracking: https://github.com/oven-sh/bun/issues/27006
FROM oven/bun:1.2-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
# `--ignore-scripts` skips install hooks for ssh2, sharp, cpu-features, etc.
# (matches the previous pnpm `ignoredBuiltDependencies` behaviour and avoids
# native compile work the Next.js build doesn't need).
RUN bun install --frozen-lockfile --ignore-scripts

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# server.js is created by next build from the standalone output.
# Bun runs Node-compatible server.js without changes.
CMD ["bun", "server.js"]
