# OpsDeck

A self-hosted operations panel for managing servers, projects, databases, and
internal knowledge from a single control plane. Built as a whitelabel app
(`NEXT_PUBLIC_APP_NAME` overrides the "OpsDeck" branding), it lets a small team
provision databases, run backups, control services, and keep documentation —
all over SSH against your own infrastructure.

## Features

- **Servers** — register hosts and run operations over SSH (`node-ssh`).
- **Projects & runs** — group infrastructure work; long-running operations are
  tracked as runs with live status and streamed logs.
- **Databases** — create, rename, and drop databases on PostgreSQL and SQL
  Server, plus backup and restore (including cross-database file relocation).
- **Services** — control `docker`, `systemd`, and `kubernetes` services.
- **Knowledge base** — collections of rich-text documents (Tiptap) with
  full-text search, revisions, internal linking, image attachments (Garage
  object storage), breadcrumbs, and a scroll-spy table of contents.
- **Auth & teams** — email/password and optional Microsoft (Entra ID) sign-in
  via [better-auth](https://better-auth.com), `viewer`/`member`/`maintainer`/
  `admin` roles, invitations, and optional email-domain whitelisting.
- **Background jobs** — long-running operations run through
  [BullMQ](https://bullmq.io/) on Valkey/Redis (backups, restores, service
  control, database lifecycle). An in-process worker drains the queue.
- **Internationalization** — `en`, `id`, `ar`, `zh` via `next-intl`.
- **Email** — transactional mail via [Resend](https://resend.com) + React Email
  (optional; disabled when unconfigured).
- **Web terminal** — an interactive SSH shell in the browser, opened from the
  server list or from the file explorer at the folder being browsed. Admin-only;
  each session's open and close is written to the activity log (never its
  contents). Runs in its own container so a redeploy cannot kill a live shell.
  Under `next dev`, `bun run terminal` alone isn't reachable — the client
  dials the page's own origin, so the sidecar needs Caddy in front of it.

## Tech stack

| Layer        | Choice                                              |
| ------------ | --------------------------------------------------- |
| Framework    | Next.js 16 (App Router) · React 19                  |
| Language     | TypeScript 7 · Bun runtime (Node 24 for builds only) |
| Database     | PostgreSQL 18 · Drizzle ORM (UUIDv7 keys)           |
| Auth         | better-auth                                         |
| Jobs / queue | BullMQ · Valkey/Redis                               |
| UI           | Tailwind CSS 4 · Base UI / shadcn · Tiptap          |
| Tooling      | Bun · Biome · `bun test`                            |

## Getting started

Requirements: **Bun ≥ 1.3**, **Node.js ≥ 20** on `PATH`, and a **PostgreSQL**
instance. Bun is the package manager, the test runner, and the server runtime.
Node is never used to run the app — it is only needed for `next build`, because
Turbopack's plugin runtime evaluates PostCSS/loaders in child `node` processes.
Point those at Bun (as the `oven/bun` images do, where `node` is a symlink to
`bun`) and the build segfaults on teardown after producing correct output.

```bash
bun install
cp .env.example .env   # then fill in the values below
bun run db:migrate     # apply schema migrations
bun run dev            # http://localhost:3000
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
| `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN`| no       | Only this email domain may hold an account       |
| `RESEND_API_KEY`                  | no       | Enables transactional email                      |
| `EMAIL_FROM`                      | no       | From address (derived from branding if unset)    |
| `MICROSOFT_CLIENT_ID`             | no       | Entra ID app registration — enables Microsoft sign-in |
| `MICROSOFT_TENANT_ID`             | no       | Entra directory (tenant) ID — pins sign-in to your directory |
| `MICROSOFT_CLIENT_SECRET`         | no       | Entra client secret value                        |

### Sign in with Microsoft (Entra ID)

Optional. Set all three `MICROSOFT_*` variables to show a "Sign in with
Microsoft" button on the sign-in page; leave them all blank to hide it. Setting
only some of them is a startup error — without a tenant ID, better-auth falls
back to the `common` authority and would accept any Microsoft account.

In the Azure portal, under **Entra ID → App registrations → your app**:

1. Copy the **Application (client) ID** and **Directory (tenant) ID**.
2. **Certificates & secrets → New client secret** — copy the *Value* (not the
   Secret ID). Client secrets expire; note the expiry date.
3. **Enterprise applications → Properties → Assignment required = Yes**, then
   assign the group that should have access. This is the gate — see below.
4. **App registrations → Authentication → Add a platform → Web**, redirect URI
   `<BETTER_AUTH_URL>/api/auth/callback/microsoft`.
5. If your directory users have no `mail` attribute, add the optional `email`
   claim under **Token configuration** — sign-in fails without an email claim.

Microsoft sign-in **self-provisions**: whoever Entra lets through gets an
account on first sign-in, with no invitation. Access is governed in Entra so
offboarding there also revokes panel access. Two app-side limits back that up —
users outside `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN` are rejected outright, and new
users land on the read-only `viewer` role until an admin promotes them.
Invitations remain for anyone who needs a higher role up front, and
email/password sign-up stays disabled.

Full setup guide, error codes, and secret rotation: [`docs/microsoft-sign-in.md`](docs/microsoft-sign-in.md).

## Scripts

| Command                | Description                            |
| ---------------------- | -------------------------------------- |
| `bun run dev`          | Start the dev server                   |
| `bun run build`        | Production build                       |
| `bun run start`        | Run the production build               |
| `bun run lint`         | Lint with Biome                        |
| `bun run check`        | Format + lint, write fixes             |
| `bun run typecheck`    | Typecheck with `tsc --noEmit`          |
| `bun test`             | Run the test suite                     |
| `bun run db:generate`  | Generate a Drizzle migration           |
| `bun run db:migrate`   | Apply pending migrations               |
| `bun run db:studio`    | Open Drizzle Studio                    |

## Docker

`compose.yaml` brings up the full stack — app, PostgreSQL, Valkey, a Garage
object store, an imgproxy image server, and `terminal` (WebSocket terminal
sessions — same image as `app`, different entrypoint). Set the required
secrets in `.env`, then:

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
actions/      Server actions (servers, databases, backups, services, runs, knowledge, …)
app/          Next.js App Router — [locale] pages + /api routes
components/    UI components (shadcn / Base UI-based)
lib/          Core libs — db, auth, ssh, email, branding, validation, queue + jobs/
drizzle/      Migrations + generated artifacts
messages/     i18n message catalogs (ar/en/id/zh)
tests/        `bun test` suite + preload (DOM, stubs, test env)
```

## License

[MIT](LICENSE) © 2026 Romi Kusuma Bakti
