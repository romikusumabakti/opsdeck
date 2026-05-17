# OpsDeck

A whitelabel admin panel for managing servers, projects, services, and database lifecycle tasks over SSH.

## Stack

- **Next.js 16** (App Router) on **React 19**
- **Drizzle ORM** + **PostgreSQL**
- **better-auth** for authentication and invitations
- **Inngest** for background jobs
- **node-ssh** for remote server operations
- **Tailwind CSS 4** + **Radix UI**
- **next-intl** for i18n
- **Biome** for lint/format

Node >= 24. Package manager: **pnpm** (also supports Bun via `bun.lock`).

## Getting started

```bash
pnpm install
cp .env.example .env   # if present; otherwise create one — see Environment
pnpm db:push           # apply schema to the database
pnpm dev
```

The app boots on http://localhost:3000.

## Scripts

| Script | What it does |
|--------|--------------|
| `pnpm dev` | Start the Next.js dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm lint` / `format` / `check` | Biome lint / format / both |
| `pnpm db:generate` | Generate Drizzle migrations from schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:push` | Push schema directly (dev only) |
| `pnpm db:studio` | Open Drizzle Studio |

## Environment

Required for any real deployment — see `lib/branding.ts`:

```env
NEXT_PUBLIC_APP_NAME=Your Panel Name
NEXT_PUBLIC_COMPANY_NAME=Your Company
NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN=yourdomain.com
```

Plus the usual database, auth, and mail provider credentials (Postgres URL, better-auth secret, Resend key, Inngest signing key, etc.). The fallback branding defaults are generic placeholders and should not be relied on in production.

## Layout

```
app/[locale]/        Routes (servers, projects, users, account, auth flows)
actions/             Server actions
components/          UI components (Radix + shadcn-style primitives)
hooks/               React hooks
i18n/                next-intl setup
inngest/             Background job definitions
lib/                 Shared utilities, branding, db client, auth
messages/            i18n message catalogs
public/              Static assets
docs/                Internal documentation (see docs/time-mocking-api.md)
```

## Deployment

A `Dockerfile` and `compose.yaml` are provided for containerized deploys; `Jenkinsfile` covers CI. Set the `NEXT_PUBLIC_*` branding vars at build time so they are baked into the client bundle.
