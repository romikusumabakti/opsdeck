# Next.js → Vite + Hono Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Next.js 16 with a Vite + React SPA (TanStack Router + Query) served by a Hono API on Bun, and move tests to Vitest + Playwright. Everything users see and every URL stays the same.

**Architecture:** `server/` is a Hono app on `Bun.serve`. It serves `/api/*`, better-auth, the SSE streams and the in-process BullMQ worker. In production it also serves the built SPA from `dist/client` with an `index.html` fallback. The old server actions become plain service functions (`server/services/*`). Thin Hono routers (`server/routes/*`) expose them, with zod validation and a typed `AppType`. `web/` is the Vite SPA: file-based TanStack Router under `/$locale`, TanStack Query for data, and the Hono RPC client (`hc<AppType>`) for transport. `web/api/*` wrappers keep the old action names, so components change only their import path. Any successful non-GET API call invalidates all queries. That replaces `revalidatePath("/", "layout")`.

**Tech Stack:** Bun 1.4, Postgres 18, Drizzle 1.0 rc, Hono 4.13, Vite 8, React 19.3, TanStack Router 1.170 / Query 5.105 / Table 9, Tailwind 4.3 (`@tailwindcss/vite`), shadcn (base-ui), TypeScript 7, better-auth 1.7, use-intl 4.14, Biome 2.5, Vitest 5, Playwright 1.64.

**Spec:** None. The user skipped the design conversation ("start"). This plan's Architecture and Global Constraints are the spec. Every decision in them was made by Claude.

## Global Constraints

- The stack is already Postgres, Drizzle, React, TanStack Table, Tailwind, shadcn, TypeScript, better-auth and Biome. Keep all of them and their current major versions. No DB schema change and no new migration.
- Package manager stays bun (`bun add`, `bun.lock`). Never use npm/pnpm. Runtimes come from mise.
- URLs are unchanged: every page lives under a `/<locale>/` prefix (`ar|en|es|id|zh`, default `en`, prefix always). API paths under `/api/*` keep their exact current paths and methods, because external callers use them (Jira webhook, mock-time API, health check).
- Process layout is unchanged: the app listens on `PORT` (default 3000), `GET /api/health` returns 200, and the terminal sidecar stays a separate process on 3001 behind Caddy `/ws/terminal*`.
- Security headers from `next.config.ts` ship on every response, including static assets and `index.html`: CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(self)`. No HSTS. No `X-Powered-By`.
- The branding env vars `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_COMPANY_NAME` and `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN` are renamed to `APP_NAME`, `COMPANY_NAME` and `ALLOWED_EMAIL_DOMAIN`. They are read at runtime by the server, and the client gets them from `/api/bootstrap`. compose.yaml maps each new var with a fallback to the old one (`${APP_NAME:-${NEXT_PUBLIC_APP_NAME-}}`), so the prod `.env` keeps working.
- All developer-facing text is in English. Any new user-facing string goes into all five `messages/{ar,en,es,id,zh}.json`.
- Conventional-commit messages. No `Co-Authored-By: Claude` trailer.
- The `server-only` package is removed. The server/client boundary is enforced by Biome `noRestrictedImports`: `web/**`, `components/**` and `hooks/**` may not import `@/server/*`, `@/lib/db*`, `@/lib/auth`, `@/lib/authz`, `@/lib/secrets`, `@/lib/ssh` or `@/lib/jobs/*`. They may still `import type` from `@/server/app`.
- Pinned versions: hono ^4.13.14, @hono/zod-validator ^0.9.1, vite ^8.3.5, @vitejs/plugin-react ^6.1.2, @tailwindcss/vite ^4.3.3, @tanstack/react-router ^1.170.46, @tanstack/router-plugin ^1.168.48, @tanstack/react-query ^5.105.0, vitest ^5.0.5, @playwright/test ^1.64.1, use-intl ^4.14.9, happy-dom ^21.0.4, @fontsource-variable/inter, @fontsource-variable/jetbrains-mono, @fontsource/ibm-plex-sans-arabic ^5.3.0.

## Review Focus

1. **A stale or expired session cookie on a deep link.** `/id/servers/abc` with a dead cookie must land on `/id/sign-in?redirect=/servers/abc`, keeping the locale, and after sign-in return to `/id/servers/abc`. It must not show a blank page or loop. Pinned in Task 6 (`authGate` unit test) and Task 13 (e2e).
2. **Old URLs.** `/en/users/x` must go to `/en/admin/users/x`, the same for `jira` and `activity`. `/en/projects/KEY/...` and `/en/project/KEY/...` must take the canonical path. A path with no locale (`/servers`) must get the default-locale prefix. Pinned in Task 6 (`resolveRedirect` tests).
3. **Production refresh on a deep link.** It must return `index.html` with the security headers. An unknown `/api/nope` must return a JSON 404, never `index.html`. Pinned in Task 6 (Hono static tests) and Task 13.
4. **Mutations show up elsewhere without a reload.** Creating an issue, marking a notification read or creating an environment must update the sidebar counts and the bell, as `revalidatePath("/", "layout")` did. Pinned in Task 6 (api-client invalidation test) and Task 13.
5. **Locale switch to `ar` on the client.** It must set `<html dir="rtl" lang="ar">` and the Arabic font with no reload. Switching back must reset both. Pinned in Task 7 and Task 13.

---

## File Structure

```
server/
  index.ts              Bun entry: validateEnv(), startWorker(), Bun.serve(app)
  app.ts                Hono composition; exports `app` and `type AppType`
  context.ts            contextStorage-based request context: getRequest(), getLocale(), session memo
  errors.ts             HttpError helpers + onError → JSON {error} with status
  i18n.ts               getServerTranslator(namespace) for server-rendered text (emails, notifications)
  static.ts             prod static serving + SPA fallback
  middleware/security-headers.ts
  middleware/locale.ts  X-Locale header → context (fallback Accept-Language → "en")
  routes/<module>.ts    one Hono router per domain module (same names as services/)
  services/<module>.ts  former actions/<module>.ts, framework-free
web/
  index.html            Vite entry (at repo root as /index.html, see Task 6)
  main.tsx              createRoot, QueryClientProvider, RouterProvider
  router.tsx            createRouter(routeTree, context: { queryClient })
  styles.css            former app/globals.css
  api/client.ts         hc<AppType> instance + fetch wrapper (X-Locale, 401 → sign-in, mutation invalidation)
  api/<module>.ts       client wrappers named like the old actions + queryOptions factories
  routes/__root.tsx
  routes/$locale/...    file routes mirroring app/[locale]/...
  routeTree.gen.ts      generated, committed
i18n/
  locales.ts            unchanged
  branding.ts           applyBranding() moved out of i18n/request.ts
  navigation.ts         Link / useRouter / usePathname / useSearchParams / redirect on TanStack Router
lib/redirects.ts        resolveRedirect(pathname) — admin moves + canonical project path + missing locale
e2e/                    Playwright specs + global-setup.ts
vitest.config.ts, playwright.config.ts, vite.config.ts
```

Deleted at cutover (Task 12): `app/`, `actions/`, `proxy.ts`, `instrumentation.ts`, `next.config.ts`, `next-env.d.ts`, `bunfig.toml` test preload, `tests/preload.ts`, `tests/next-config-redirects.test.ts`, `postcss.config.mjs`, and the Next block in `AGENTS.md`.

From Task 2 until Task 12, `tsconfig.json` excludes `app/`, `actions/`, `proxy.ts`, `instrumentation.ts` and `next.config.ts`. That keeps `bun run typecheck` meaningful for the new code while the old tree is still around for reference.

---

### Task 1: Move the unit tests to Vitest

**Files:**
- Create: `vitest.config.ts`, `tests/setup.ts`
- Modify: all `tests/*.test.ts`, `package.json` scripts, `bunfig.toml` (drop `[test]`)
- Delete: `tests/preload.ts`

**Interfaces:**
- Produces: `bun run test` runs `bun --bun vitest run`, and `bun run test:watch` runs `bun --bun vitest`. Vitest runs on the Bun runtime because `terminal-server.test.ts` drives a real `Bun.serve`.

- [ ] **Step 1:** `bun add -d vitest@^5.0.5 happy-dom@^21.0.4`, then remove `@happy-dom/global-registrator`.
- [ ] **Step 2:** In `vitest.config.ts`, set `test.environment: "node"`, `setupFiles: ["tests/setup.ts"]`, `include: ["tests/**/*.test.ts"]`, and resolve the `@/` alias to the repo root. `tests/setup.ts` sets `process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db"` and calls `vi.mock("server-only", () => ({}))`. That mock lasts only until Task 2 removes the package.
- [ ] **Step 3:** Mechanical port. `bun:test` imports become `vitest`. `mock.module(id, f)` becomes top-level `vi.mock(id, f)`. `spyOn` becomes `vi.spyOn`. `mock.restore()` becomes `vi.restoreAllMocks()`. `Bun.file(p).text()` becomes `readFile(p, "utf8")` from `node:fs/promises`. `new Bun.Glob(g).scanSync(root)` becomes `globSync(g, { cwd: root })` from `node:fs`. `Bun.sleep` becomes `setTimeout` from `node:timers/promises`. `tests/knowledge-editor.test.ts` gets a `// @vitest-environment happy-dom` docblock.
- [ ] **Step 4:** Run `bun run test`. Expect the same pass count as `bun test` gave on `main` (record it first with `git stash; bun test`).
- [ ] **Step 5:** Commit `test: move unit tests from bun:test to vitest`.

### Task 2: Server foundation — Hono app, request context, framework-free auth

**Files:**
- Create: `server/{index,app,context,errors,i18n}.ts`, `server/middleware/{security-headers,locale}.ts`, `tests/server-app.test.ts`
- Modify: `lib/auth-session.ts`, `lib/auth.ts` (drop `nextCookies()` and `after()`; fire-and-forget with `void promise.catch(log)`), `lib/authz.ts`, `lib/env-url.ts`, `lib/env.ts` (drop the `NEXT_PHASE` skip), `lib/branding.ts` (new env names), every file importing `server-only` (delete the import), `tsconfig.json` (remove the next plugin and `.next` includes, add the excludes listed above), `package.json` (`hono`, `@hono/zod-validator`; script `"dev:server": "bun --watch server/index.ts"`)

**Interfaces:**
- Produces:
  - `server/context.ts`: `getRequestHeaders(): Headers`, `getLocale(): Locale`, plus `getServerSession()` with a per-request memo stored in the Hono context. Hono's `contextStorage()` / `getContext()` carries the request through AsyncLocalStorage, so the existing `requireSession()`, `requireOrgPermission()`, `requireProjectPermission()` etc. keep their signatures and their ~180 call sites do not change.
  - `server/errors.ts`: `unauthorized(): never` (401), `forbidden(): never` (403), `notFound(): never` (404). Each throws `HTTPException`. `onError` renders `{ error: string }` with the status. Unknown errors are logged and return 500 `{ error: "Internal Server Error" }`.
  - `lib/auth-session.ts`: `requireSession()` throws 401 instead of redirecting. `lib/authz.ts`: `requireOrgPage` / `requireProjectPage` become aliases of the `*Permission` guards (403/404). `routeProjectGuard` / `routeOrgGuard` keep their `{ ok, response }` shape.
  - `server/i18n.ts`: `getServerTranslator(namespace?: string): Promise<(key, values?) => string>`, built on `createTranslator` from `use-intl/core` with branded messages for `getLocale()`.
  - `server/app.ts`: `export const app`. It applies `contextStorage()`, the security headers, the locale middleware and the `/api/auth/*` → `auth.handler(c.req.raw)` handler for GET and POST, and serves `GET /api/health`. Task 4/5 routers mount here with `.route("/api/<module>", router)`. `export type AppType = typeof app`.
  - `server/index.ts`: `validateEnv(); startWorker(); export default { port: Number(process.env.PORT ?? 3000), hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 0 }`. `idleTimeout: 0` keeps SSE streams from being cut at Bun's 10 s default.

- [ ] **Step 1:** Write `tests/server-app.test.ts` using `app.request()`:
  - `GET /api/health` → 200.
  - The response carries all five security headers with the exact values from Global Constraints and no `x-powered-by`.
  - `GET /api/auth/get-session` with no cookie → 200 body `null`.
  - A test-only route registered on a fresh `new Hono()` built with the same middleware, which calls `requireSession()`, → 401 `{ error: "Unauthorized" }`.
  - A route calling `getLocale()` with `X-Locale: id` → `"id"`. With `Accept-Language: ar,en;q=0.8` → `"ar"`. With `X-Locale: xx` → `"en"`.
- [ ] **Step 2:** Run `bun run test tests/server-app.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3:** Implement the files listed above. The middleware order is `contextStorage` → security headers → locale.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`. Expect all tests to pass. Typecheck errors may appear only in the not-yet-moved importers of `next/*` outside the excluded paths (the components listed in Task 6). List them in the commit body.
- [ ] **Step 5:** Commit `feat(server): add Hono app with request context and framework-free auth`.

### Task 3: Turn server actions into services

**Files:**
- Move: `actions/<m>.ts` → `server/services/<m>.ts` for all 28 modules (`git mv`)
- Modify: `tests/authz-guards.test.ts` (scan `server/services` and `server/routes` instead of `actions` and `app`), every `lib/**` import of `@/actions/*`

**Interfaces:**
- Produces: the same exported function names and signatures as today, framework-free. These are the rules:
  - Drop `"use server"`. Delete `revalidatePath` / `revalidateTag` / `updateTag` (the client invalidates instead, see Task 6).
  - `notFound()` from next becomes `notFound()` from `@/server/errors`.
  - A `redirect(x)` *after a successful mutation* becomes a return value: widen the return type with `redirectTo: string` (locale-free path), and the caller navigates. A `redirect` used as an auth gate becomes the matching `server/errors` throw.
  - `getTranslations(ns)` from `next-intl/server` becomes `getServerTranslator(ns)`.
  - `headers()` / `cookies()` become `getRequestHeaders()`.

- [ ] **Step 1:** Update `tests/authz-guards.test.ts` to scan `server/services/**` (and `server/routes/**`, allowed to be empty) and keep every existing assertion. Run it. Expect FAIL (directory missing).
- [ ] **Step 2:** `git mv actions server/services` and apply the rules. Then `grep -rE 'next/|next-intl/server|"use server"' server lib` must print nothing.
- [ ] **Step 3:** Run `bun run test` and `bun run typecheck`. Expect PASS, with no typecheck errors under `server/` or `lib/`.
- [ ] **Step 4:** Commit `refactor(server): convert server actions to framework-free services`.

### Task 4: API routers — work tracking, knowledge, people

**Files:**
- Create: `server/routes/{issues,issue-attachments,labels,milestones,saved-views,notifications,home,activity,knowledge,users,profile,access,project-members,project-catalog}.ts`, `tests/routes-batch-a.test.ts`
- Modify: `server/app.ts` (mount the routers)
- Port route handlers: `app/api/issues/**`, `app/api/knowledge/asset/**`, `app/api/avatars/**`, `app/api/users/[id]/card`

**Interfaces:**
- Consumes: Task 3's services and Task 2's guards.
- Produces: one chained Hono router per module, mounted at `/api/<module>`, so `AppType` infers every endpoint. These are the conventions:
  - Read-only service functions become `GET`, with arguments as `zValidator("query"|"param")`.
  - Mutating functions become `POST /<kebab-function-name>`, with `zValidator("json", schema)` built from the existing zod schemas in `lib/validation.ts` where they exist. The body is `{ ...args }`, named after the service parameters.
  - The response is `c.json(result)`.
  - Anything a page or layout in `app/[locale]/**` read directly from `lib/**` (e.g. `lib/home/queries`, `lib/knowledge`, `lib/people/*`) gets a `GET` in the owning module's router, and the page stops touching `lib` for that data.
  - Ported `app/api/*` handlers keep their exact path and method. They are mounted directly on `app` when the path does not fit `/api/<module>`.
  - Add `GET /api/me` → `{ user, orgRole, timeZone } | null` and `GET /api/bootstrap` → `{ appName, companyName, allowedEmailDomain, brand, microsoftSignIn: boolean }` (no auth on bootstrap).

- [ ] **Step 1:** Write `tests/routes-batch-a.test.ts`. For each mounted module, pick one GET and one POST endpoint and assert 401 without a session (via `app.request`). Also assert `GET /api/bootstrap` → 200 with the five keys, and `GET /api/me` → 200 `null`.
- [ ] **Step 2:** Run it. Expect FAIL (404s).
- [ ] **Step 3:** Implement the routers and ported handlers.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`. Expect PASS. `authz-guards` must now cover the new route files.
- [ ] **Step 5:** Commit `feat(server): expose issues, knowledge and people APIs via Hono`.

### Task 5: API routers — environments, infrastructure, integrations, streams

**Files:**
- Create: `server/routes/{environments,services,runs,backups,databases,mail,mailpit-settings,mock-time,test-runs,servers,s3-connections,explorer,tunnels,jira}.ts`, `tests/routes-batch-b.test.ts`
- Port: `app/api/environments/**`, `app/api/explorer/**`, `app/api/runs/**`, `app/api/jira/webhook/[token]`, `app/api/terminal/ticket`, `app/brand/icon.svg`

**Interfaces:**
- Same conventions as Task 4. SSE handlers (`runs/[id]/stream`, `runs/running/stream`, `mail/events`, `services/[role]/logs/stream`) use `streamSSE` from `hono/streaming`. They keep the same event names and payloads, `POLL_INTERVAL_MS` and the 10-minute cap, and they stop on `stream.onAbort`. Uploads use `c.req.parseBody()` / `c.req.raw.body` streaming as the current handlers do. Downloads return `new Response(stream, { headers })` unchanged.

- [ ] **Step 1:** Write `tests/routes-batch-b.test.ts`. For each module, one GET and one POST → 401 without a session. Also: `POST /api/jira/webhook/bad-token` gives the same status the current handler returns for an unknown token, `GET /brand/icon.svg` → 200 `image/svg+xml`, and `GET /api/runs/<uuid>/stream` without a session → 401.
- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`. Expect PASS. Then `grep -rL "" app/api` cross-check: every file under `app/api/**/route.ts` must have a matching handler (list them in the commit body).
- [ ] **Step 5:** Commit `feat(server): expose environment, infra and integration APIs via Hono`.

### Task 6: Web foundation — Vite, router, i18n, API client, redirects, static serving

**Files:**
- Create: `vite.config.ts`, `index.html`, `web/{main,router}.tsx`, `web/styles.css` (moved from `app/globals.css`), `web/routes/__root.tsx`, `web/routes/$locale/route.tsx`, `web/routes/index.tsx` (→ redirect to `/en`), `web/api/client.ts`, `web/api/<module>.ts` for each Task 4/5 module, `i18n/branding.ts`, `lib/redirects.ts`, `server/static.ts`, `tests/{redirects,api-client,static,auth-gate}.test.ts`
- Rewrite: `i18n/navigation.ts`
- Modify: `biome.json` (noRestrictedImports from Global Constraints; ignore `web/routeTree.gen.ts` and `dist`), `package.json`, `.gitignore` (`dist`)

**Interfaces:**
- `vite.config.ts`:
  - Plugins in this order: `tanstackRouter({ target: "react", autoCodeSplitting: true, routesDirectory: "web/routes", generatedRouteTree: "web/routeTree.gen.ts" })`, `react()`, `tailwindcss()`.
  - `resolve.tsconfigPaths: true`. `build.outDir: "dist/client"`.
  - `server.proxy`: `/api` and `/brand` → `http://localhost:3000`, and `/ws/terminal` → `ws://localhost:3001` (with `ws: true`).
  - Scripts: `"dev": "bun run --parallel dev:server dev:web"`, `"dev:web": "vite"`, `"build": "vite build && bun build server/index.ts --target=bun --outdir dist/server && bun build lib/terminal/main.ts --target=bun --outfile dist/terminal-server.js"`, `"start": "bun dist/server/index.js"`.
- `lib/redirects.ts`: `resolveRedirect(pathname: string): { to: string; status: 301 | 302 | 308 } | null`. Rules:
  - No locale prefix → `/en<path>` (302).
  - `/<l>/(users|jira|activity)/<rest>` → `/<l>/admin/<section>/<rest>` (302).
  - `canonicalProjectPath(stripped)` non-null → `/<l><canonical>` (308).
  - `/api/*`, `/brand/*` and `/assets/*` are never redirected.
- `i18n/navigation.ts`: the same export names as today, so the ~97 importers do not change. `Link` (props `href: string`, plus the anchor props in use) renders TanStack `<Link to={"/" + locale + href}>`. `useRouter()` returns `{ push, replace, back, refresh, prefetch }`; `refresh` calls `queryClient.invalidateQueries()` and `router.invalidate()`. `usePathname()` returns the path without the locale. `useSearchParams()` returns `URLSearchParams` from `useLocation().searchStr`. `useParams()` is `useParams({ strict: false })`. `redirect(href)` throws TanStack `redirect({ href: localized })` for use in loaders. Consumers of `next/navigation` (34 files) switch their import to `@/i18n/navigation`.
- `web/api/client.ts`: `export const api = hc<AppType>("/", { fetch: apiFetch })`. `apiFetch` sets `X-Locale` from the current route. On 401 it navigates to `/<locale>/sign-in?redirect=<current path without locale>`. On a 2xx with a method other than GET/HEAD it calls `queryClient.invalidateQueries()`. A non-2xx otherwise throws `ApiError { status, message }` (reuse `lib/fetch-error.ts` if it fits).
- `web/api/<module>.ts`: exports functions with the old action names and parameter lists (e.g. `setIssueLabels(issueId, labelIds)`), each implemented with `api`. Read functions also export `<name>Query(args)` → `queryOptions({ queryKey: ["<module>", "<name>", args], queryFn })`.
- `web/routes/$locale/route.tsx`:
  - `params.parse` rejects unknown locales with `notFound()`.
  - `beforeLoad` calls `authGate(location, me)`. `authGate` is exported from `web/auth-gate.ts` and is pure. If `me` is null and the first segment after the locale is not one of `sign-in, accept-invite, setup, forgot-password, reset-password`, it returns `redirect({ to: "/$locale/sign-in", search: { redirect: strippedPath } })`.
  - The loader ensures `meQuery` and `bootstrapQuery` and loads the messages (`import(\`../../../messages/${locale}.json\`)` + `applyBranding`). The component wraps children in `IntlProvider` (`locale`, `messages`, `timeZone = effectiveTimeZone(me?.user)`) and sets `document.documentElement.lang/dir` in an effect.
- `web/routes/__root.tsx`: `beforeLoad` applies `resolveRedirect(location.pathname)` (client-side fallback). It also provides `errorComponent` (port of `app/global-error.tsx`), `notFoundComponent` (port of `app/not-found.tsx`) and `pendingComponent`.
- `server/static.ts`: `mountStatic(app)`, active only when `NODE_ENV === "production"`:
  - `/assets/*` → `serveStatic({ root: "./dist/client" })` with `Cache-Control: public, max-age=31536000, immutable`.
  - Other files in `dist/client` and `public/` are served as-is.
  - Any other GET not under `/api/` → the `resolveRedirect` result as a real HTTP redirect if non-null, else `dist/client/index.html` with `Cache-Control: no-cache`.
  - `/api/*` misses → `404 { error: "Not Found" }`.

- [ ] **Step 1:** Write the tests.
  - `tests/redirects.test.ts`:
    - `/servers` → `/en/servers` 302
    - `/id/users/abc` → `/id/admin/users/abc` 302
    - `/en/jira` → `/en/admin/jira` 302
    - `/api/health` → null
    - `/en/servers` → null
    - Port every case from `tests/routing.test.ts` and `tests/next-config-redirects.test.ts` that exercises canonical paths, with the expected 308.
  - `tests/auth-gate.test.ts`: `/id/servers/abc` with `me = null` → redirect to sign-in with `search.redirect === "/servers/abc"` and locale `id`. `/id/sign-in` with `me = null` → no redirect. `/id/servers` with a user → no redirect.
  - `tests/api-client.test.ts`: stub `fetch`. A POST that returns 200 calls `invalidateQueries` once. A GET does not call it. A 401 calls the injected navigator with `/en/sign-in?redirect=%2Fservers`.
  - `tests/static.test.ts`, with `NODE_ENV=production` and a temp `dist/client/index.html` fixture: `GET /en/servers/x` → 200 HTML carrying the security headers. `GET /api/nope` → 404 JSON. `GET /servers` → 302 `/en/servers`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. `bun add hono` is already done. Run `bun add @tanstack/react-router @tanstack/react-query use-intl @fontsource-variable/inter @fontsource-variable/jetbrains-mono @fontsource/ibm-plex-sans-arabic`, then `bun add -d vite @vitejs/plugin-react @tailwindcss/vite @tanstack/router-plugin`. Import the fonts in `web/styles.css` and map them to the same CSS variables the `next/font` setup produced (`--font-sans`, `--font-mono`, `--font-arabic`; check `app/[locale]/layout.tsx` for the exact names).
- [ ] **Step 4:** Run `bun run test`, `bun run typecheck`, `bun run lint` and `bun run build`. Expect PASS and a `dist/client/index.html`. Smoke test: `NODE_ENV=production bun run start`, then `curl -sI localhost:3000/en/sign-in` → 200 text/html.
- [ ] **Step 5:** Commit `feat(web): add Vite SPA foundation with TanStack Router, i18n and Hono RPC client`.

### Task 7: App shell and auth pages

**Files:**
- Create: `web/routes/$locale/_app/route.tsx` (authenticated shell, the port of `app/[locale]/layout.tsx`), `web/routes/$locale/{sign-in,setup,forgot-password,reset-password}.tsx`, `web/routes/$locale/accept-invite.$token.tsx`
- Modify: `components/**` and `hooks/**`. Imports from `next-intl` become `use-intl`. `next/navigation` and `next/link` become `@/i18n/navigation`. `next/dynamic` becomes `React.lazy`. `@/actions/<m>` becomes `@/web/api/<m>`. Cookie reads done in the old layout (sidebar state etc.) move to `document.cookie` in the component that owns them.

**Interfaces:**
- The shell route is pathless (`_app`), and every authenticated page is its child. Its loader ensures the queries the old layout awaited: `listEnvironments`, `getAssignedIssueCounts`, `getUnreadNotificationCount`, `listNotifications` and `listProjects`. Its component renders the same provider tree in the same order as `app/[locale]/layout.tsx`.
- Page conversion rule, used by Tasks 7–11:
  - `page.tsx` becomes a route file whose `loader` calls `context.queryClient.ensureQueryData(x)` for every query the server component awaited. The component reads them with `useSuspenseQuery`.
  - `loading.tsx` becomes `pendingComponent`. `error.tsx` becomes `errorComponent`. `notFound()` becomes `throw notFound()`.
  - Page-level permission checks (`requireOrgPage`) become a `beforeLoad` that checks `canOrg(me.orgRole, perms)` and throws `notFound()` when it fails. The server still enforces them per endpoint.
  - `getTranslations` becomes `useTranslations`. Page titles go in `head: () => ({ meta: [{ title }] })`, with `<HeadContent />` in `__root`.
  - `*-client.tsx` files move next to their route under `web/routes/.../-components/`. The `-` prefix keeps the router from treating them as routes.

- [ ] **Step 1:** Write `tests/locale-dir.test.tsx` (happy-dom). Render the `$locale` route component's effect helper `applyDocumentLocale("ar")`: `document.documentElement.dir` is `"rtl"` and `lang` is `"ar"`. Then `applyDocumentLocale("en")` → `"ltr"` / `"en"`.
- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3:** Implement the shell and the auth pages. `sign-in` honours `search.redirect` through `lib/safe-redirect.ts`.
- [ ] **Step 4:** Run `bun run test`, `bun run typecheck` and `bun run lint`. Then run `bun run dev` against the local Postgres and walk through manually: sign-in, a wrong password error, setup on an empty DB, the sidebar rendering and a locale switch to `ar`.
- [ ] **Step 5:** Commit `feat(web): port app shell and auth pages`.

### Task 8: Pages — home, projects, project area

**Files:**
- Port: `app/[locale]/(home)/**`, `projects/**`, `project/**`, `environments/new`, `[projectKey]/{page,loading,milestones-client,project-members-client}.tsx`, `[projectKey]/settings/**`, `[projectKey]/issues/[number]/**`, `[projectKey]/environments/new/**`
- Into: `web/routes/$locale/_app/{index,projects.*,environments.new,$projectKey.*}.tsx` (use TanStack flat-file naming)

- [ ] **Step 1:** For each ported page, check that the loader's `ensureQueryData` calls match the awaits in the old `page.tsx` and `layout.tsx` one to one. Record the list in the commit body.
- [ ] **Step 2:** Run `bun run typecheck`, `bun run lint` and `bun run test`. Expect PASS.
- [ ] **Step 3:** Manual check in `bun run dev`: home sections load, create a project, open an issue by number, edit settings, and confirm `/en/projects/KEY` 308s to the canonical path.
- [ ] **Step 4:** Commit `feat(web): port home and project pages`.

### Task 9: Pages — environment area

**Files:**
- Port: everything under `app/[locale]/[projectKey]/[envSlug]/**` (layout, dashboard, backup/restore, databases, history, issues, mail, mock-time, services and logs, settings)
- Into: `web/routes/$locale/_app/$projectKey.$envSlug.*`. The env layout becomes `$projectKey.$envSlug.route.tsx`.

- [ ] **Step 1:** Do the same loader-parity check as Task 8 Step 1. The mock-time page read `docs/time-mocking-api.md` at runtime. Import it with `?raw` in the route instead, so the Dockerfile no longer copies `docs/`.
- [ ] **Step 2:** Run `bun run typecheck`, `bun run lint` and `bun run test`. Expect PASS.
- [ ] **Step 3:** Manual check: the live run panel streams (SSE through the Vite proxy), the mail inbox receives an event, the service logs stream, and a backup run enqueues and completes.
- [ ] **Step 4:** Commit `feat(web): port environment pages`.

### Task 10: Pages — global issues, knowledge, people, account

**Files:**
- Port: `app/[locale]/{issues,knowledge,people,account}/**` → `web/routes/$locale/_app/{issues,knowledge.*,people.*,account.*}.tsx`

- [ ] **Step 1–3:** Same loader-parity check, the same checks as Task 8, and a manual check of knowledge create/edit/history with an image upload, passkey list and the people card.
- [ ] **Step 4:** Commit `feat(web): port issues, knowledge, people and account pages`.

### Task 11: Pages — servers, storage, admin

**Files:**
- Port: `app/[locale]/{servers,storage,admin}/**` → `web/routes/$locale/_app/{servers.*,storage.*,admin.*}.tsx`. The admin layout becomes `admin.route.tsx`, whose `beforeLoad` checks `{ audit: ["read"] }`.

- [ ] **Step 1–3:** Same loader-parity check and the same checks as Task 8. Manual check: the terminal connects over `/ws/terminal` through the Vite proxy, the file explorer uploads and downloads an archive, an S3 browse works, a tunnel route is added, a Jira connection is saved and the users access matrix works.
- [ ] **Step 4:** Commit `feat(web): port servers, storage and admin pages`.

### Task 12: Cutover — remove Next.js and update packaging

**Files:**
- Delete: the list under File Structure
- Modify: `package.json`, `tsconfig.json`, `Dockerfile`, `compose.yaml`, `Caddyfile`, `.github/workflows/ci.yml`, `README.md`, `.env.example`, `AGENTS.md` (remove the Next block; delete the file if it is then empty), `biome.json` (drop the `.next`/`next-env` ignores)

**Interfaces:**
- `package.json`: remove `next`, `next-intl`, `server-only` and `@tailwindcss/postcss`. Add the scripts `typecheck: "tsc --noEmit"` (unchanged) and `"db:*"` (unchanged).
- `Dockerfile`: `bun install --frozen-lockfile` → `bun run build`. The runner copies `dist/` and runs `CMD ["bun", "dist/server/index.js"]`, keeping user uid 1001 (rename `nextjs` → `app`), port 3000 and `HOSTNAME=0.0.0.0`. The terminal sidecar command becomes `["bun", "dist/terminal-server.js"]`.
- `compose.yaml`: the branding env names with fallbacks (Global Constraints) and the updated comments. `Caddyfile`: remove the `header_down Location ":3000/"` workaround and its comment.

- [ ] **Step 1:** Run `grep -rnE "next/|next-intl|NEXT_PUBLIC|NEXT_RUNTIME|server-only|@/actions/" --include=*.ts --include=*.tsx --include=*.json --include=*.yaml --include=Dockerfile .` excluding `node_modules`, `docs` and `bun.lock`. Expect no output.
- [ ] **Step 2:** Run `bun install`, `bun run lint`, `bun run typecheck`, `bun run test` and `bun run build`. Expect all to PASS.
- [ ] **Step 3:** Run `docker compose build app` and `docker compose up -d`. `curl -sI http://localhost/en/sign-in` must return 200 with the security headers.
- [ ] **Step 4:** Commit `build!: remove Next.js; serve the Vite SPA from Hono`.

### Task 13: Playwright end-to-end suite and CI

**Files:**
- Create: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/{auth,routing,i18n,mutations}.spec.ts`
- Modify: `package.json` (`"test:e2e": "playwright test"`), `.github/workflows/ci.yml`

**Interfaces:**
- `playwright.config.ts`: `webServer: { command: "bun run build && bun run start", url: "http://localhost:3000/api/health", reuseExistingServer: !process.env.CI }`, with `env` carrying test secrets. Projects: chromium only.
- `e2e/global-setup.ts`: refuses to run unless the database name in `DATABASE_URL` ends with `_e2e`. Then it runs `drop schema public cascade; create schema public;` and `bunx drizzle-kit migrate`.
- CI: a new `e2e` job with `postgres:18` and `valkey/valkey:8-alpine` services, `DATABASE_URL=postgres://postgres:postgres@localhost:5432/opsdeck_e2e`, then `bunx playwright install --with-deps chromium` and `bun run test:e2e`. The existing job replaces `bun test` with `bun run test`.

- [ ] **Step 1:** Write the specs.
  - `auth.spec.ts`:
    1. Setup creates the first admin and lands on `/en`.
    2. Sign out, then open `/id/servers` → URL becomes `/id/sign-in?redirect=%2Fservers`. Sign in → URL is `/id/servers`.
    3. A context with a forged cookie `better-auth.session_token=bogus` on `/en/servers` ends on `/en/sign-in`.
  - `routing.spec.ts`:
    - `/servers` → `/en/servers`.
    - `/en/users` → `/en/admin/users`.
    - `page.reload()` on `/en/admin/users` keeps the URL and renders the heading.
    - `request.get("/api/nope")` → 404 with JSON content-type.
    - The response for `/en/sign-in` has `x-frame-options: DENY`.
  - `i18n.spec.ts`: use the locale switcher to pick العربية → `html[dir=rtl][lang=ar]` and the URL starts with `/ar/`. Switch to English → `dir=ltr`.
  - `mutations.spec.ts`: create a project and an issue assigned to self from the UI → the sidebar's assigned-issues badge increments without `page.reload()`.
- [ ] **Step 2:** Locally, `createdb opsdeck_e2e` against compose Postgres, then run `DATABASE_URL=…/opsdeck_e2e bun run test:e2e`. Expect 4 files, all passing.
- [ ] **Step 3:** Commit `test(e2e): add Playwright suite and CI job`.
