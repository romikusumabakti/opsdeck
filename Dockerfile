FROM oven/bun:1.4.4-slim AS base

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

# `opsdeck backup run` needs pg_dump (and restore pg_restore) of the server's
# major, 18, which Debian does not ship: client only, from the PGDG apt repo.
# The repo key is pinned by checksum.
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
RUN chmod 644 /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

# Debian's useradd/groupadd — oven/bun:slim has no busybox addgroup/adduser.
# The home directory is needed: Bun writes to $HOME when it loads the native
# .node addon bundled with the server (ssh2's cpufeatures) and fails with EACCES
# if $HOME does not exist. `opsdeck` on PATH runs the CLI (bun dist/cli.js).
# /var/lib/opsdeck/backups holds local backups (bind-mounted from ${dir}/backups).
RUN groupadd --system --gid 1001 app \
    && useradd --system --create-home --uid 1001 --gid app app \
    && printf '#!/bin/sh\nexec bun /app/dist/cli.js "$@"\n' > /usr/local/bin/opsdeck \
    && chmod 755 /usr/local/bin/opsdeck \
    && install -d -o app -g app /var/lib/opsdeck/backups

# The release workflow passes the version without the leading v (1.2.3). It is
# baked in so /api/health and the update check can report what is running.
# Declared after the apt and useradd layers so a new version reuses them.
ARG OPSDECK_VERSION=0.0.0-dev
ENV OPSDECK_VERSION=$OPSDECK_VERSION

# The server resolves ./dist/client and ./public against the working directory.
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/public ./public
# `opsdeck migrate` (dist/cli.js) reads the migrations from ./drizzle.
COPY --from=builder --chown=app:app /app/drizzle ./drizzle

USER app

EXPOSE 3000

ENV PORT=3000

# The terminal sidecar is a second entrypoint into this same image, selected by
# `command:` in compose (bun dist/terminal-server.js).
CMD ["bun", "dist/server/index.js"]
