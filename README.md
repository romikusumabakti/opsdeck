# OpsDeck

A self-hosted operations panel for managing servers, projects, databases, and
internal knowledge from a single control plane. Built as a whitelabel app
(`NEXT_PUBLIC_APP_NAME` overrides the "OpsDeck" branding), it lets a small team
provision databases, run backups, control services, and keep documentation —
all over SSH against your own infrastructure.

## Features

- **Servers** — register hosts and run operations over SSH (`node-ssh`).
- **Projects & tasks** — group infrastructure work; long-running operations are
  tracked as tasks with live status and streamed logs.
- **Databases** — create, rename, and drop databases on PostgreSQL and SQL
  Server, plus backup and restore (including cross-database file relocation).
- **Services** — control `docker`, `systemd`, and `kubernetes` services.
- **Knowledge base** — collections of rich-text documents (Tiptap) with
  full-text search, revisions, internal linking, breadcrumbs, and a
  scroll-spy table of contents.
- **Auth & teams** — email/password via [better-auth](https://better-auth.com),
  `admin`/`member` roles, invitations, and optional email-domain whitelisting.
- **Background jobs** — durable operations run through self-hosted
  [Inngest](https://www.inngest.com/) (backups, restores, service control,
  database lifecycle).
- **Internationalization** — `en`, `id`, `ar`, `zh` via `next-intl`.
- **Email** — transactional mail via [Resend](https://resend.com) + React Email
  (optional; disabled when unconfigured).

## Tech stack

| Layer        | Choice                                              |
| ------------ | --------------------------------------------------- |
| Framework    | Next.js 16 (App Router) · React 19                  |
| Language     | TypeScript 6 · Node 24                              |
| Database     | PostgreSQL 18 · Drizzle ORM (UUIDv7 keys)           |
| Auth         | better-auth                                         |
| Jobs / queue | Inngest (self-hosted) · Valkey/Redis                |
| UI           | Tailwind CSS 4 · Radix UI / shadcn · Tiptap         |
| Tooling      | pnpm · Biome · Vitest                               |

## Getting started

Requirements: **Node ≥ 24**, **pnpm**, and a **PostgreSQL** instance.

```bash
pnpm install
cp .env.example .env   # then fill in the values below
pnpm db:migrate        # apply schema migrations
pnpm dev               # http://localhost:3000
```

On first run, open the app and complete the `/setup` flow to create the initial
admin account.

### Environment

| Variable                          | Required | Purpose                                          |
| --------------------------------- | -------- | ------------------------------------------------ |
| `DATABASE_URL`                    | yes      | App PostgreSQL connection string                 |
| `BETTER_AUTH_URL`                 | yes      | Public base URL of the app                       |
| `BETTER_AUTH_SECRET`              | yes      | Auth signing secret                              |
| `INNGEST_EVENT_KEY`               | yes      | Inngest event key (must match the Inngest server)|
| `INNGEST_SIGNING_KEY`            | yes      | Inngest signing key                              |
| `INNGEST_BASE_URL`                | no       | Self-hosted Inngest event API (Docker setup)     |
| `NEXT_PUBLIC_APP_NAME`            | no       | Whitelabel app name (defaults to `OpsDeck`)      |
| `NEXT_PUBLIC_COMPANY_NAME`        | no       | Whitelabel company name                          |
| `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN`| no       | Restrict sign-up to one email domain             |
| `RESEND_API_KEY`                  | no       | Enables transactional email                      |
| `EMAIL_FROM`                      | no       | From address (derived from branding if unset)    |

## Scripts

| Command            | Description                                |
| ------------------ | ------------------------------------------ |
| `pnpm dev`         | Start the dev server                       |
| `pnpm build`       | Production build                           |
| `pnpm start`       | Run the production build                   |
| `pnpm lint`        | Lint with Biome                            |
| `pnpm check`       | Format + lint, write fixes                 |
| `pnpm test`        | Run the Vitest suite                       |
| `pnpm db:generate` | Generate a Drizzle migration               |
| `pnpm db:migrate`  | Apply pending migrations                   |
| `pnpm db:studio`   | Open Drizzle Studio                        |

## Docker

`compose.yaml` brings up the full stack — app, PostgreSQL, Valkey, and a
self-hosted Inngest server. Set the required secrets in `.env`, then:

```bash
docker compose up -d --build
```

Inngest runs in production mode and needs a dedicated `inngest` database
(`INNGEST_POSTGRES_URI`), separate from the app's own database. App functions
are registered via Inngest sync after the stack is up.

## Project layout

```
actions/      Server actions (servers, databases, backups, services, tasks, knowledge, …)
app/          Next.js App Router — [locale] pages + /api routes
components/    UI components (shadcn / Radix-based)
inngest/      Background job client + functions
lib/          Core libs — db, auth, ssh, email, branding, validation
drizzle/      Migrations + generated artifacts
messages/     i18n message catalogs (ar/en/id/zh)
tests/        Vitest tests
```

## License

Private — all rights reserved.
