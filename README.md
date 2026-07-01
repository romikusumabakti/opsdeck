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
  full-text search, revisions, internal linking, image attachments (Garage
  object storage), breadcrumbs, and a scroll-spy table of contents.
- **Auth & teams** — email/password via [better-auth](https://better-auth.com),
  `admin`/`member` roles, invitations, and optional email-domain whitelisting.
- **Background jobs** — long-running operations run through
  [BullMQ](https://bullmq.io/) on Valkey/Redis (backups, restores, service
  control, database lifecycle). An in-process worker drains the queue.
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
| Jobs / queue | BullMQ · Valkey/Redis                               |
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
| `REDIS_URL`                       | no       | Valkey/Redis URL for BullMQ (worker off if unset)|
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

`compose.yaml` brings up the full stack — app, PostgreSQL, Valkey, a Garage
object store, and an imgproxy image server. Set the required secrets in `.env`,
then:

```bash
docker compose up -d --build
```

Background jobs run on BullMQ against the `valkey` service (`REDIS_URL`
defaults to `redis://valkey:6379`). The worker runs in-process inside the app
container — started by Next's `instrumentation` hook on boot — so there is no
separate worker service to manage.

### Object storage setup (Garage)

Knowledge-base image attachments are stored in [Garage](https://garagehq.deuxfleurs.fr/)
(S3-compatible, self-hosted). After the stack is up, provision the layout,
bucket, and access key **once**:

```bash
# 1. Assign storage to the single node and apply the layout
docker compose exec garage /garage layout assign -z dc1 -c 10G $(docker compose exec garage /garage status | awk 'NR==3{print $1}')
docker compose exec garage /garage layout apply --version 1

# 2. Create the bucket (must match S3_BUCKET)
docker compose exec garage /garage bucket create knowledge

# 3. Create an access key and grant it read/write on the bucket
docker compose exec garage /garage key create app-key      # prints Key ID + Secret
docker compose exec garage /garage bucket allow --read --write knowledge --key app-key
```

Copy the printed **Key ID** / **Secret** into `S3_ACCESS_KEY` / `S3_SECRET_KEY`
in `.env`, then restart the affected services
(`docker compose up -d app imgproxy`).

Image handling: the app stores the **original** upload in Garage and never
processes images itself (no native `sharp`/`libvips` in the bundle). Resizing
and format conversion happen on read in the **imgproxy** container, which pulls
straight from Garage and negotiates AVIF/WebP from the browser's `Accept`
header. Both the bucket and imgproxy stay private — every image is served
through the session-gated `/api/knowledge/asset/<id>` route, which signs a
short-lived imgproxy URL server-side. Set `IMGPROXY_KEY` / `IMGPROXY_SALT`
(`openssl rand -hex 32` each) in `.env`; the app and the imgproxy service must
share the same values.

## Project layout

```
actions/      Server actions (servers, databases, backups, services, tasks, knowledge, …)
app/          Next.js App Router — [locale] pages + /api routes
components/    UI components (shadcn / Radix-based)
lib/          Core libs — db, auth, ssh, email, branding, validation, queue + jobs/
drizzle/      Migrations + generated artifacts
messages/     i18n message catalogs (ar/en/id/zh)
tests/        Vitest tests
```

## License

Private — all rights reserved.
