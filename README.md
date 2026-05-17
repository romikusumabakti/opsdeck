# Admin Panel

Whitelabel internal admin panel — manages server SSH credentials, database backup/restore jobs, Jenkins-driven deployments, and project/service inventory.

Branding (app name, company name, allowed email domain) is configurable via env vars — see [Environment](#environment).

## Stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Auth:** better-auth (email/password, invites, password reset)
- **DB:** PostgreSQL 18 via Drizzle ORM
- **Background jobs:** Inngest (backup/restore, long-running SSH tasks)
- **SSH:** node-ssh for remote command execution
- **Email:** Resend + React Email templates
- **i18n:** next-intl
- **UI:** Tailwind CSS v4 + Radix UI primitives
- **Tooling:** pnpm, Biome, TypeScript

## Prerequisites

- Node.js >= 24
- pnpm 10 (`corepack enable pnpm`)
- Docker + Docker Compose (for Postgres + Inngest dev server)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in the required variables (see below)
docker compose up -d postgres inngest
pnpm db:push           # apply schema to the database
pnpm dev
```

App runs at <http://localhost:3000>. The Inngest dev UI runs at <http://localhost:8288>.

## Environment

Required:

- `DATABASE_URL` — Postgres connection string
- `BETTER_AUTH_SECRET` — random secret for session signing
- `BETTER_AUTH_URL` — base URL (e.g. `http://localhost:3000`)

Optional:

- `RESEND_API_KEY`, `EMAIL_FROM` — email features disabled when unset. If `EMAIL_FROM` is omitted it falls back to `"<APP_NAME> <no-reply@<EMAIL_DOMAIN>>"`.
- `INNGEST_DEV` — URL of the local Inngest dev server
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — required in production

Whitelabel branding (all required for a branded deployment):

- `NEXT_PUBLIC_APP_NAME` — displayed app name (e.g. `Admin Panel`)
- `NEXT_PUBLIC_COMPANY_NAME` — footer copyright (e.g. `Acme Corp`)
- `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN` — email domain accepted for sign-up/invite (e.g. `acme.com`)

If unset, defaults fall back to generic placeholders (`Admin Panel`, `the company`, `example.com`) — set these for any real deployment.

## Scripts

| Command           | Description                              |
|-------------------|------------------------------------------|
| `pnpm dev`        | Start Next.js dev server                 |
| `pnpm build`      | Production build                         |
| `pnpm start`      | Run the production build                 |
| `pnpm check`      | Biome format + lint with autofix         |
| `pnpm lint`       | Biome lint only                          |
| `pnpm db:generate`| Generate Drizzle migrations from schema  |
| `pnpm db:migrate` | Apply pending migrations                 |
| `pnpm db:push`    | Push schema directly (dev shortcut)      |
| `pnpm db:studio`  | Open Drizzle Studio                      |

## Project Layout

```
app/[locale]/   # localized routes (sign-in, projects, servers, users, …)
app/api/        # auth, health, inngest, task endpoints
actions/        # server actions (backups, servers, services, users, …)
inngest/        # Inngest client and background functions
lib/            # auth, db (schema/relations), email, ssh, roles, utils
components/     # UI components (Radix + Tailwind)
messages/       # next-intl translations
hooks/          # React hooks
docs/           # internal documentation
```

## Deployment

Production runs via `docker compose up -d --build` on the deploy host. Jenkins (`Jenkinsfile`) copies the host `.env` into the workspace and rebuilds the stack. The Next.js image uses the standalone output (see `Dockerfile`).
