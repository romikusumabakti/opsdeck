# OpsDeck

A self-hosted, whitelabel hub where a delivery team (PM, BA, QA, Dev and DevOps) does its work. It brings together project environments, database operations, an issue tracker, a knowledge base and server access, so nobody has to jump between half a dozen tools.

## Features

- **Projects and environments.** Each project has environments (dev, staging, prod, and so on). For each environment you can manage services and stream their logs, and manage databases (Postgres, MSSQL, MySQL/MariaDB on Docker or Kubernetes). You can also run backups and restores, mock the system clock, view Mailpit mail and see the run history.
- **Background runs.** Backups, restores, database changes, service control and Jira sync are queued on BullMQ. Their progress streams live to the browser.
- **Issue tracker.** Issues come with labels, milestones, saved views, test runs, attachments and project membership. Optional two-way sync with Jira is available.
- **Knowledge base.** Rich-text pages (Tiptap) with revision history. Images are stored in S3 (Garage) and served through imgproxy.
- **Servers.** SSH connections, an SFTP file explorer and a browser terminal (xterm.js).
- **Storage.** Browse S3-compatible buckets.
- **Cloudflare tunnels and DNS zones**, managed with a scoped API token.
- **Home.** A "needs attention" feed of recent failures that users can acknowledge.
- **Access control.** Roles, per-environment access, project members and an activity log.
- **Auth.** Built on better-auth: email/password, passkeys, invites, password reset and optional Microsoft Entra ID sign-in.
- **i18n.** English, Bahasa Indonesia, Español, 中文 and العربية (RTL).

## Stack

Next.js 16 (App Router) · React 19 · Bun · Drizzle ORM + PostgreSQL 18 · BullMQ + Valkey · better-auth · Tailwind CSS 4 + shadcn/ui · next-intl · Garage (S3) + imgproxy · Biome

## Architecture

```
            cloudflared / browser
                    │
                 Caddy :80
          ┌─────────┴──────────┐
   /ws/terminal*           everything else
          │                    │
 terminal :3001             app :3000 ── BullMQ worker (in-process)
 (WebSocket sidecar)           │
          │        ┌───────────┼───────────┬──────────┐
          └──── postgres     valkey      garage ─── imgproxy
```

`compose.yaml` defines the services:

| Service    | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `app`      | Next.js standalone server. The BullMQ worker starts inside it from `instrumentation.ts`. |
| `terminal` | Same image, running `terminal-server.js`. It holds the WebSocket terminal sessions, because Next can't serve WebSockets and keeping the sockets in their own process means a redeploy can't kill a live shell. |
| `caddy`    | Public edge on `127.0.0.1:80`, plain HTTP. TLS is expected to end upstream (for example at cloudflared). |
| `postgres` | Main database, published on `127.0.0.1:5432` for migrations.          |
| `valkey`   | Redis-compatible queue backend for BullMQ.                              |
| `garage`   | Single-node S3 store for knowledge-base attachments.                    |
| `imgproxy` | Resizes images and converts their format on read. Internal only.        |

## Configuration

Copy `.env.example` to `.env` (Compose) or `.env.local` (host `next dev`) and fill it in. Each variable is documented inline. At startup the app validates its environment (`lib/env.ts`):

- It refuses to boot if a core variable is missing, a value is malformed or a feature is only half configured.
- Optional features (Microsoft sign-in, Resend email, S3 keys) that are left blank are disabled, and the app logs an `[env]` warning.

Generate the secrets once:

```sh
openssl rand -base64 32   # SECRETS_KEY, BETTER_AUTH_SECRET, GARAGE_ADMIN_TOKEN
openssl rand -hex 32      # GARAGE_RPC_SECRET, IMGPROXY_KEY, IMGPROXY_SALT
```

> [!WARNING]
> - `SECRETS_KEY` encrypts stored credentials (SSH and database passwords, S3 keys). If you rotate it, the existing secrets can no longer be decrypted and have to be re-entered.
> - `BETTER_AUTH_URL` must be the exact origin users visit. Passkeys are bound to it, and the terminal rejects WebSocket upgrades from any other origin.
> - `NEXT_PUBLIC_*` branding variables are baked in at build time, so changing them means rebuilding the image.

### Brand and accent colour

`BRAND` picks the deployment's brand: its logo shape and the default accent colour. It can be `default` (a plain grid logo, neutral accent) or `dss` (the DSS Panel "D" logo, blue accent). The server reads it at runtime, so switching brands takes a `docker compose up -d app`, not a rebuild.

Each user can pick their own accent colour from the user menu (**Accent color**) or the command palette. The choices are `neutral` plus shadcn/ui's seven colour themes: blue, green, orange, red, rose, violet and yellow. The choice is stored on the user's account (`users.accent_color`), so it follows them across devices; until they pick one, they get the brand's default. The root layout sets `data-accent` on `<html>`.

The theme is the stock shadcn/ui token set in `app/globals.css`. Each accent binds its Tailwind palette steps to `--tint-*` variables, and two role blocks map those onto the shadcn tokens:
- light mode uses step 900 for buttons and step 100 for the active sidebar item;
- dark mode uses step 300 for buttons and step 950 for the active sidebar item;
- the focus ring uses step 500 in light mode and 400 in dark mode, or a darker step where 500 falls below 3:1 (green and orange use 600, yellow 700).

Neutral greys, status colours and charts are never tinted. Components never name accent colours directly. `tests/accent-theme.test.ts` checks that every accent keeps text at WCAG AA (4.5:1) and its focus ring at 3:1 in both modes.

Logos are code, not image files, so that they can take the accent's colours and animate. In the app, the tiles assemble on load and part on hover, and the status tile pulses while runs are in progress. All of this is skipped for users who prefer reduced motion. The favicon at `/brand/icon.svg?accent=…` is drawn from the same shape in the user's accent, and follows the browser's light or dark scheme. Its colours live in `lib/accent-palette.ts`, which `tests/accent-palette.test.ts` pins to Tailwind's palette.

To add an accent colour:
1. Add its name to `ACCENTS` in `lib/accents.ts`.
2. Add a `[data-accent="…"]` binding block in `app/globals.css`.
3. Add its steps and values to `ACCENT_STEPS` and `ACCENT_PALETTE` in `lib/accent-palette.ts`.
4. Add its swatch classes in `components/accent-dot.tsx`.
5. Add its name to `accentSwitcher` in all five `messages/*.json` files.

The tests then check contrast and palette agreement.

To add a brand:
1. Add its name to `BRANDS` in `lib/branding.ts` and its default accent to `BRAND_DEFAULT_ACCENT` in `lib/accents.ts`.
2. Give it a logo shape in `lib/brand-logos.ts`.

### Background motifs

Faint Nusantara ornaments sit in the corners of the pages outside the app (sign-in, setup, password reset, invitations, errors) and at the bottom of the sidebar. There are eleven, one per major region, ordered west to east: Pintu Aceh, Gorga, Pucuk Rebung, Megamendung, Kawung, Batang Garing, Patra Punggel, Pa' Barre Allo, Mamuli, Tenun Tanimbar and Ukiran Asmat. Everyone sees the same motif each day (it changes at midnight `APP_TIMEZONE`); each user can pin one or turn them off from the user menu (**Motif**) or the command palette, stored in `users.motif`. The ⓘ button outside the app and **About …** in the menu show a short cultural note.

The images are masks: `components/motif-watermark.tsx` paints `--ring` (the accent's saturated step) through them, so they follow the theme and accent. The source art in `design/motifs/` was generated with `gpt-image-2.5-sunburst` (templates and per-motif subjects in `design/motifs/prompts.json`).

To add or replace a motif:
1. Put a black-on-transparent PNG at `design/motifs/<slug>.png` and run `node scripts/build-motifs.mjs`. Generate a new motif with the `v2` template in `prompts.json`: its uniform line weight keeps every ornament at a similar density.
2. For a new motif, add it to `MOTIFS` in `lib/motifs.ts` at its place by longitude.
3. Add its `items.<slug>` caption to `motifs` in all five `messages/*.json` files.

## Running with Docker Compose

```sh
cp .env.example .env              # fill in; leave S3_ACCESS_KEY / S3_SECRET_KEY blank for now
docker compose up -d --build
```

Apply database migrations from the host. Postgres is published on localhost, and `drizzle.config.ts` reads `.env.local`, so point `DATABASE_URL` in that file at `localhost:5432`:

```sh
bun install
bun run db:migrate
```

Open the site and go to `/en/setup` to create the first admin account. The setup page closes once any user exists.

### Object storage setup

You only need Garage credentials for knowledge-base image uploads. Do this once after the first boot:

```sh
alias garage='docker compose exec garage /garage'

garage status                                   # note the node ID
garage layout assign -z dc1 -c 10G <node-id>
garage layout apply --version 1
garage bucket create knowledge
garage key create opsdeck-app                   # prints Key ID + Secret key
garage bucket allow --read --write --owner knowledge --key opsdeck-app
```

Put the key ID and secret into `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `.env`, then recreate the services that use them:

```sh
docker compose up -d app imgproxy
```

#### User profiles

User avatars share the same bucket under the `avatars/` prefix and are served through imgproxy, so nothing extra needs configuring. No env or compose changes are needed.

## Local development

Requirements: Bun ≥ 1.3, Node 24 (only for `scripts/build-motifs.mjs`), and a PostgreSQL instance.

```sh
bun install
cp .env.example .env.local        # set DATABASE_URL host to localhost
bun run db:migrate
bun run dev                       # http://localhost:3000
bun run terminal                  # web-terminal sidecar on :3001 (optional)
```

Valkey publishes no host port, so background jobs only run in host dev if `REDIS_URL` points at a Redis/Valkey instance you can reach. When `REDIS_URL` is unset, the worker is disabled and the rest of the app still works.

### Scripts

| Command                      | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `bun run dev` / `build` / `start` | Next.js dev server, production build, server  |
| `bun run terminal`           | Run the web-terminal WebSocket sidecar            |
| `bun test`                   | Unit tests (happy-dom; no database needed)        |
| `bun run typecheck`          | `tsc --noEmit`                                    |
| `bun run lint` / `format` / `check` | Biome                                       |
| `bun run db:generate`        | Generate a migration from `lib/db/schema.ts`      |
| `bun run db:migrate`         | Apply pending migrations in `drizzle/`            |
| `bun run db:studio`          | Drizzle Studio                                    |

CI (`.github/workflows/ci.yml`) runs `biome ci`, the typecheck, the tests and a production build on every push and pull request.

### Translations

Each user-facing string must be added to all five files in `messages/`: `ar`, `en`, `es`, `id` and `zh`.

## Project layout

```
app/[locale]/     Pages (every URL is locale-prefixed)
app/api/          Route handlers: health, run streams, Jira webhook, uploads, terminal tickets
actions/          Server actions
components/       UI components (shadcn/ui in components/ui)
lib/              Domain logic: db schema, auth, jobs, jira, terminal, tunnels, mailpit, explorer
drizzle/          SQL migrations
messages/         i18n message catalogs
tests/            bun test suites + fixtures
docs/             Design docs and guides
```

## Further docs

- [`docs/microsoft-sign-in.md`](docs/microsoft-sign-in.md): Microsoft Entra ID sign-in setup
- [`docs/time-mocking-api.md`](docs/time-mocking-api.md): the time-mocking API that environments have to implement
- [`docs/jira-integration-plan.md`](docs/jira-integration-plan.md): design of the Jira two-way sync
- [`docs/rework-plan.md`](docs/rework-plan.md): roadmap for the multi-role hub

## License

[MIT](LICENSE) © 2026 Romi Kusuma Bakti
