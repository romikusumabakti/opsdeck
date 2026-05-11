# Admin Panel

Internal admin panel for the company. Manages SSH-accessed servers and
runs Postgres backup/restore against remote Docker containers via Inngest
background jobs. Access is invitation-only and limited to
`@example.com` accounts.

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19**
- **Bun** as package manager and runtime
- **Postgres 18** + **Drizzle ORM** (UUIDv7 primary keys via Postgres'
  built-in `uuidv7()`)
- **better-auth** with Drizzle adapter (no public sign-up)
- **Inngest** for backup/restore jobs
- **node-ssh** for remote command execution
- **Resend** + `@react-email/components` for invitation emails
- **next-intl** (`id` default, `en`)
- **Tailwind CSS 4** + Radix UI primitives (shadcn-style components)
- **Biome** for lint/format

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- A Postgres 18 instance (older versions lack the built-in `uuidv7()`
  function the schema depends on)
- A Resend API key if you want invitation emails to work

## Setup

```bash
bun install
cp .env.local.example .env.local   # then fill in the values below
bun run db:push                     # apply schema to your dev DB
bun dev                             # http://localhost:3000
```

On first launch, navigate to `/setup` to create the bootstrap user.
After at least one user exists, that endpoint becomes a no-op and
further accounts can only be created via invitation from `/users`.

## Environment variables

`.env.local` is used for host-mode development (`bun dev`,
`drizzle-kit`). `compose.yaml` ignores it and reads `.env` instead.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string used by both the app and `drizzle-kit`. |
| `BETTER_AUTH_URL` | yes | Public origin of the app (used for cookies, invitation links, trusted origins). |
| `BETTER_AUTH_SECRET` | yes | Random secret for session signing. Generate with `openssl rand -hex 32`. |
| `NEXT_PUBLIC_APP_URL` | no | Exposed to the client; defaults to `http://localhost:3000`. |
| `RESEND_API_KEY` | no | Without it, invitation emails fail to send. |
| `EMAIL_FROM` | no | Defaults to `Admin Panel <no-reply@example.com>`. |

For Docker Compose, also set `POSTGRES_PASSWORD` (required) and
optionally `POSTGRES_USER`, `POSTGRES_DB`, `INNGEST_EVENT_KEY`,
`INNGEST_SIGNING_KEY`.

## Scripts

```bash
bun dev            # next dev (Turbopack)
bun run build      # production build (standalone output)
bun start          # serve the production build

bun run lint       # biome lint
bun run format     # biome format --write
bun run check      # biome check --write (lint + format)

bun run db:push       # push schema directly (dev workflow)
bun run db:generate   # generate SQL migrations from schema
bun run db:migrate    # apply generated migrations
bun run db:studio     # open Drizzle Studio
```

## Project structure

```
app/                    Next.js App Router pages
  setup/                Bootstrap-only page for the first user
  sign-in/              Credentials sign-in
  accept-invite/[token] Invitation acceptance flow
  account/change-password
  users/                User & invitation management
  servers/              Server CRUD (SSH credentials)
  projects/[projectId]/ Per-project actions: backup-database, restore-database, history
  api/{auth,health,inngest}
actions/                Server actions (`"use server"`); most call `requireSession()`
  projects.ts servers.ts users.ts backups.ts jenkins.ts locale.ts
lib/
  auth.ts               better-auth config (UUIDv7 generator, example.com allow-list)
  auth-session.ts       getServerSession / requireSession helpers
  ssh.ts                executeRemoteCommand + testSshConnection
  db/                   schema.ts + relations.ts (Drizzle)
  email/                Resend client + React Email templates
inngest/
  client.ts             Inngest client
  functions.ts          syncJenkinsData, createDatabaseBackup, restoreDatabaseBackup
components/             App shell + ui/ (shadcn-style Radix wrappers)
i18n/                   next-intl config; messages live in messages/{id,en}.json
proxy.ts                Edge middleware: redirects unauthenticated requests to /sign-in
```

## Auth model

- No public sign-up. `emailAndPassword.disableSignUp` is `true` in
  `lib/auth.ts`.
- Only `@example.com` emails are accepted (see `isAllowedEmail`).
- The first user is created via `/setup`, which refuses to run once any
  user exists.
- Subsequent users are invited from `/users`. Invitations are random
  32-byte hex tokens that expire after 48 hours and are delivered via
  Resend.
- Sessions last 7 days and refresh after 1 day of activity.
- All custom `actions/*` calls that touch data go through
  `requireSession()`. The Edge middleware (`proxy.ts`) redirects
  unauthenticated browser requests to `/sign-in`.

## Backup & restore

`createDatabaseBackup` (event `db/backup.requested`) SSHes into
`project.dbServer`, ensures `dbBackupPath` exists inside the container,
then runs `pg_dump | gzip` (or `BACKUP DATABASE` via `sqlcmd` for MSSQL)
through `docker exec`. All filesystem operations target the container —
`dbBackupPath` is interpreted as a container-internal path. Bind-mount
configuration (if the operator wants host-side access to backups) is the
operator's concern in docker-compose, not the panel's.

`restoreDatabaseBackup` (event `db/restore.requested`) terminates open
connections to the target database and pipes the dump back through
`docker exec ... psql` (or `RESTORE DATABASE` via `sqlcmd` for MSSQL),
using `dbServiceName`, `dbBackupPath`, and `dbName` from the project
record.

Both functions execute remote shell commands, so server credentials in
the `servers` table effectively grant code execution on those hosts.
Treat the database as sensitive.

## Docker

`compose.yaml` provisions three services:

- `postgres` (Postgres 18, port 5432, volume `postgres_data`)
- `app` (built from `Dockerfile`, exposed on port 80 → 3000)
- `inngest` (official `inngest/inngest` image, port 8288)

```bash
docker compose up -d --build --remove-orphans
```

The app's `Dockerfile` is a multi-stage Next.js standalone build
(`node:20-alpine`).

## Notes

- Lockfile of record is `bun.lock`. A `pnpm-lock.yaml` exists but Bun is
  the supported workflow.
- Schema IDs are UUIDv7 — tables we own default to Postgres'
  `uuidv7()`; better-auth tables generate IDs in JS via the `uuid`
  package, configured in `lib/auth.ts`.
- Project → server foreign keys use `onDelete: "restrict"`; deleting a
  server while a project still references it returns Postgres error
  `23503`, surfaced as a translated message.
