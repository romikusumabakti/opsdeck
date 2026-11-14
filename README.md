# OpsDeck

A self-hosted operations panel for teams that run many projects across many
servers. Each project has environments (Dev, QA, …), and the panel ties together
what those environments need day to day:

- **Deploys** of container apps and legacy artifacts, triggered by CI build
  notifications (Woodpecker, Bitbucket), with deploy locks, health checks and
  rollback. See [`docs/deploy.md`](docs/deploy.md).
- **Environments**: services and their logs, variables, databases (backup,
  restore, provisioning), mail capture (Mailpit), mock time
  ([`docs/time-mocking-api.md`](docs/time-mocking-api.md)), history, releases.
- **Issues and milestones**, a knowledge base with image attachments, and
  Jira integration.
- **Infrastructure**: servers, SSH keys, a browser terminal, S3 connections,
  Cloudflare zones and tunnels, CI connections.
- **Instance management**: access roles, activity log, scheduled backups and
  self-update from GitHub Releases.

Sign-in is email + password, passkeys, or Microsoft Entra ID
([`docs/microsoft-sign-in.md`](docs/microsoft-sign-in.md)). The UI ships in
English, Indonesian, Spanish, Chinese and Arabic.

## Stack

| Layer      | Tech                                                                  |
| ---------- | --------------------------------------------------------------------- |
| Runtime    | Bun (version pinned in `mise.toml` and `packageManager`)              |
| Frontend   | Vite SPA, React 19, TanStack Router + Query, Tailwind 4, shadcn/ui (Base UI), use-intl |
| Backend    | Hono (`server/`), better-auth, BullMQ worker in-process               |
| Data       | PostgreSQL 18 via Drizzle ORM (`lib/db/schema.ts`, `drizzle/`)        |
| Services   | Valkey 8 (queue), Garage (S3 for attachments), imgproxy, Caddy        |
| Terminal   | Separate WebSocket sidecar (`lib/terminal/`), ssh2 + wterm            |
| Tooling    | Biome, TypeScript, Vitest, Playwright                                 |

## Repository layout

```
web/            SPA: routes (web/routes, file-based), API client, components
server/         Hono app: routes, middleware, static serving of dist/client
components/     Shared React components (shadcn/ui under components/ui)
lib/            Domain logic shared by server, CLI and terminal sidecar
lib/db/         Drizzle schema
drizzle/        Migrations (baseline + newer), run by `opsdeck migrate`
messages/       i18n catalogs: ar, en, es, id, zh
i18n/           Locale list and labels
scripts/        `opsdeck` CLI (scripts/cli.ts) and other ops scripts
ops/install/    Installer, production compose file and host updater
ops/backup/     Interim off-host backup timer (see ops/backup/README.md)
tests/          Vitest suites
e2e/            Playwright suites
docs/           Feature docs; docs/superpowers holds design specs and plans
```

## Installing an instance

Production instances are installed from a GitHub Release, not from this
checkout. On a Linux host with systemd (amd64 or arm64):

```sh
curl -fsSL https://github.com/romikusumabakti/opsdeck/releases/latest/download/install.sh | sh -s -- --hostname panel.example.com
```

The installer creates `/opt/<name>` with a digest-pinned `compose.yaml`, a
`.env` (mode 0600) with generated secrets, and a host updater unit
(`opsdeck-updater@<name>.path`), then starts the stack. Useful flags:

- `--channel stable|beta`, `--version vX.Y.Z`
- `--dir /opt/<name>`, `--http-port N`
- `--adopt <old .env>` to take over a stack started from the repo-root
  `compose.yaml` (keeps its volumes)
- `--restore <backup> --secrets-key-file <file>` for disaster recovery
- `--dry-run` to print every action without changing anything

Run `sh install.sh --help` or read the header of `ops/install/install.sh` for
the full contract. After the first start, create the first admin at
`<url>/setup`, and store `SECRETS_KEY` offline: backups never contain it and a
restore needs it.

Caddy listens on `127.0.0.1` only and serves plain HTTP. Put a tunnel
(e.g. cloudflared) or a TLS-terminating proxy in front of it.

## Local development

Requirements: [mise](https://mise.jdx.dev) (installs the pinned Bun) and Docker
or Podman with Compose.

```sh
mise install
bun install
cp .env.example .env.local     # host dev; use .env for the Compose stack
```

Fill in `.env.local`. For host dev, `DATABASE_URL` points at `localhost`, and
`SECRETS_KEY` / `BETTER_AUTH_SECRET` come from `openssl rand -base64 32`. The
app validates the environment at startup (`lib/env.ts`): a missing core
variable or a half-configured optional feature stops the boot, while an
optional feature left fully blank only logs an `[env]` warning.

Start Postgres from the Compose stack, apply migrations, then run the dev
servers:

```sh
docker compose up -d postgres
bun run db:migrate
bun run dev          # Hono on PORT (default 3000) + Vite, which proxies /api
bun run terminal     # optional: the terminal sidecar on 3001
```

Open the Vite URL and create the first admin at `/<locale>/setup`. Port 3000
may already be taken on your machine; set `PORT` (Vite reads it for its proxy).

Valkey publishes no host port, so background jobs only run in the full Compose
stack. Without `REDIS_URL` the app still boots, with the worker disabled.

For sample data on a scratch instance, `bun scripts/cli.ts seed demo
--print-passwords` creates demo projects and one account per role.

### Full stack with Compose

The repo-root `compose.yaml` builds the image from this checkout and runs
`postgres`, `migrate` (one-shot), `app`, `terminal`, `caddy`, `garage`,
`imgproxy` and `valkey`:

```sh
cp .env.example .env    # fill in every CHANGE_ME
docker compose up -d --build
```

The panel is then at `http://localhost` (Caddy on `127.0.0.1:80`).

### Object storage setup

Knowledge-base image uploads need a Garage bucket and key. The stack boots
without them; only uploads fail until they exist. In the dev stack, provision
Garage once after the first `docker compose up`:

```sh
docker exec opsdeck-garage /garage status                 # note the node ID
docker exec opsdeck-garage /garage layout assign -z dc1 -c 1G <node-id>
docker exec opsdeck-garage /garage layout apply --version 1
docker exec opsdeck-garage /garage bucket create knowledge
docker exec opsdeck-garage /garage key create opsdeck-app
docker exec opsdeck-garage /garage bucket allow --read --write --owner knowledge --key opsdeck-app
```

Put the key ID and secret from `key create` into `S3_ACCESS_KEY` and
`S3_SECRET_KEY`, then `docker compose up -d app imgproxy`. Installed instances
don't need this step: their Garage runs with `--single-node --default-bucket`
and creates the key and bucket itself.

## Scripts

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `bun run dev`          | Hono server (watch) and Vite dev server in parallel       |
| `bun run build`        | SPA, server bundle, terminal sidecar and ops CLIs → `dist/` |
| `bun run start`        | Runs the production server bundle                         |
| `bun run terminal`     | Runs the terminal sidecar from source                     |
| `bun run check`        | Biome lint + format, with fixes                           |
| `bun run typecheck`    | `tsc --noEmit`                                            |
| `bun run test`         | Vitest                                                    |
| `bun run test:e2e`     | Playwright                                                |
| `bun run db:generate`  | drizzle-kit: generate a migration from `lib/db/schema.ts` |
| `bun run db:migrate`   | Apply pending migrations (`opsdeck migrate`)              |
| `bun run db:studio`    | drizzle-kit Studio                                        |

Run other scripts as plain `bun scripts/<name>.ts`. Scripts that import
better-auth must `import "reflect-metadata"` first.

### The `opsdeck` CLI

`scripts/cli.ts` is bundled to `dist/cli.js`; in the image it is on `PATH` as
`opsdeck`:

```
opsdeck migrate [--adopt]       Apply pending migrations
opsdeck backup run [--trigger …] Back up the instance (S3 destination or local)
opsdeck restore <objectKey>     Restore an instance backup (run by the updater)
opsdeck seed demo [--print-passwords] [--force]
```

In production: `docker exec <app container> opsdeck <command>`. Locally:
`bun scripts/cli.ts <command>`.

## Database migrations

Migrations live in `drizzle/`, one folder per migration named
`<YYYYMMDDHHMMSS>_<name>/` with `migration.sql` and `snapshot.json`.
`00000000000000_baseline` is the schema squashed as of 2026-11-09; everything
after it is incremental.

They run only through Drizzle's migrator: the `migrate` service in Compose, or
`opsdeck migrate`. Never apply SQL by hand.

Writing one:

1. Change `lib/db/schema.ts`, then `bun run db:generate`. Rename the folder so
   its timestamp sorts after the newest existing one.
2. Start `migration.sql` with `SET LOCAL lock_timeout = '5s';--> statement-breakpoint`.
3. Separate statements with `--> statement-breakpoint`. Don't add
   `BEGIN`/`COMMIT`: the migrator wraps the file in a transaction.
4. Add any backfill by hand after the generated statements.
5. Keep it expand/contract: add only, and drop or rename in a later release.
   The updater migrates first and rolls the images back on failure, so the
   previous build must still work against the new schema.
6. Never edit a released migration, including the baseline's comments. Add a
   new one.

`opsdeck migrate --adopt` is for a database built before the baseline existed:
it checks that the live schema equals the baseline and records the baseline as
applied without running it (exit 2 when the schemas differ).

## Testing

```sh
bun run test                 # unit and integration suites
bun run test:e2e             # Playwright, production build
```

- Vitest workers run with `--no-env-file`, so your `.env` never leaks into
  tests and local runs match CI.
- Scratch-DB suites (`*-scratch.test.ts` and a few others) are opt-in: the
  header of each file names its env var (e.g. `BASELINE_SCRATCH_DB`). Point
  them at a database created with `opsdeck migrate`.
- Playwright builds and starts the app itself and resets the database first.
  `DATABASE_URL` must name a loopback database ending in `_e2e`; the reset
  refuses anything else. The server listens on `E2E_PORT` (default 3000), so
  pick a free port (`ss -ltnp`). `E2E_REUSE_SERVER=1` reuses a running server
  and skips the reset.

CI (`.github/workflows/ci.yml`) runs `biome ci`, typecheck, Vitest, the build
and Playwright on every push and pull request.

## i18n

UI strings use `use-intl`, with catalogs in `messages/{ar,en,es,id,zh}.json`.
Add every new key to all five files in the same change: the catalogs are not
type-checked against each other, so a missing key only breaks that language at
runtime. A new locale also needs `i18n/locales.ts`, `lib/date-fns-locale.ts`
and a `commandPalette.locale.<code>` label in every catalog.

## Releases

Pushing a tag `vX.Y.Z` (stable) or `vX.Y.Z-beta.N` (beta) runs
`.github/workflows/release.yml`. It publishes
`ghcr.io/romikusumabakti/opsdeck:<version>`, moves `:stable` or `:beta`, and
attaches the installer assets and `release.json` to the GitHub Release.
Installed instances update from that `release.json`. The version is baked into
the image as `OPSDECK_VERSION`; `package.json` stays at `0.0.0`.

## License

[MIT](LICENSE)
