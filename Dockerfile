# syntax=docker.io/docker/dockerfile:1

# Bun's official Alpine image ships an AVX2-required binary. Our Jenkins build
# host CPU has no AVX, so we replace `bun` with the `musl-baseline` variant
# from GitHub releases (built without AVX/AVX2 instructions).
FROM oven/bun:1.3.13-alpine AS base
USER root
RUN apk add --no-cache curl unzip \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-x64-musl-baseline.zip" -o /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp \
    && mv /tmp/bun-linux-x64-musl-baseline/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64-musl-baseline \
    && bun --version

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
# `--ignore-scripts` matches the previous pnpm setup which excluded ssh2,
# cpu-features, sharp, etc. from running their install hooks. Also avoids a
# SIGILL crash on AVX-less build hosts where Bun's child Node-compat process
# crashes inside ssh2's install.js.
RUN bun install --frozen-lockfile --ignore-scripts

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
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
