# OpsDeck

Whitelabel admin panel for managing servers, projects, services, and database lifecycle tasks over SSH.

## Stack

- Next.js 16 (App Router) on React 19
- PostgreSQL via Drizzle ORM
- better-auth (sessions, invitations, password reset)
- Inngest for background jobs and progress streaming
- node-ssh for remote operations
- Tailwind CSS 4, Radix UI, shadcn-style primitives
- next-intl, Resend (optional), Biome

Requires Node >= 24. Package manager: pnpm.

## Quick start

```bash
pnpm install
cp .env.example .env.local
pnpm db:push
pnpm dev
```

App runs at http://localhost:3000.

For the full stack (Postgres + Inngest + app) run via Docker:

```bash
cp .env.example .env
docker compose up --build
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm check` | Biome lint + format (write) |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:push` | Push schema directly (dev) |
| `pnpm db:studio` | Drizzle Studio |

## Environment

Copy `.env.example` and fill in. Required keys:

- `DATABASE_URL` — Postgres connection string
- `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`
- `BETTER_AUTH_URL` — public base URL of the app
- `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_COMPANY_NAME`, `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN` — whitelabel branding (baked into the client bundle at build time; set these before `pnpm build`)

Optional:

- `RESEND_API_KEY`, `EMAIL_FROM` — email delivery; email features disable cleanly if unset
- `INNGEST_DEV`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest dev server config

`isAllowedEmail()` in `lib/branding.ts` gates sign-up/invites to the configured email domain.

## Layout

```
app/[locale]/   Routes (servers, projects, users, account, auth flows, setup)
app/api/        Route handlers (auth, inngest, health)
actions/        Server actions (servers, projects, services, backups, tasks, users)
components/     UI primitives + feature components
lib/            auth, db, ssh, branding, email, shared utils
inngest/        Background job definitions
i18n/           next-intl setup
messages/       i18n catalogs
docs/           Internal docs
```

## Deployment

`Dockerfile` + `compose.yaml` provide a containerised setup (app, Postgres, Inngest dev server). For production, set the `NEXT_PUBLIC_*` branding vars at build time so they end up in the client bundle, and point `INNGEST_DEV` at a hosted Inngest or remove it to use signed prod mode.
