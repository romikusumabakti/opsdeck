FROM oven/bun:1.4.2-slim AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

COPY package.json bun.lock ./
# --frozen-lockfile fails the build if bun.lock doesn't match package.json,
# so an image can never be built from an out-of-date dependency graph.
RUN bun install --frozen-lockfile

# Build the SPA and both server bundles.
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Produces, in one step:
#   dist/client           the Vite SPA (docs/time-mocking-api.md is inlined)
#   dist/server/index.js  the Hono API + static server
#   dist/terminal-server.js  the WebSocket terminal sidecar
# Both server bundles are self-contained, including ssh2's native .node file,
# so the runtime image needs no node_modules.
RUN bun run build

# Production image: only the build output and the static public files.
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Debian's useradd/groupadd — oven/bun:slim has no busybox addgroup/adduser.
# The home directory is needed: Bun writes to $HOME when it loads the native
# .node addon bundled with the server (ssh2's cpufeatures) and fails with EACCES
# if $HOME does not exist.
RUN groupadd --system --gid 1001 app \
    && useradd --system --create-home --uid 1001 --gid app app

# The server resolves ./dist/client and ./public against the working directory.
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/public ./public

USER app

EXPOSE 3000

ENV PORT=3000

# The terminal sidecar is a second entrypoint into this same image, selected by
# `command:` in compose (bun dist/terminal-server.js).
CMD ["bun", "dist/server/index.js"]
