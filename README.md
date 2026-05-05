## Getting Started

This project uses [Bun](https://bun.sh) as its package manager and runtime.

```bash
bun install
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Scripts

```bash
bun dev            # start dev server
bun run build      # production build
bun start          # serve production build
bun run lint       # eslint
bun run db:push    # apply schema to DB (dev workflow)
bun run db:generate
bun run db:migrate
bun run db:studio
```

## Stack

- Next.js (App Router) + Turbopack
- React 19
- Drizzle ORM (Postgres)
- better-auth + Resend (email invitations)
- next-intl (id, en)
- Tailwind CSS 4
- Inngest (background jobs)
