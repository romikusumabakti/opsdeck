# Home page rebuild — design

Date: 2026-10-03
Status: approved (brainstorming), pending spec review

## Goal

Rebuild Home (`app/[locale]/(home)/page.tsx`) into a page that tells each user what needs them right now and lets them act on it without leaving the page.

## Problems with the current page

- **Noisy signal.** "Needs attention" lists the six most recent failed runs, raw. One environment failing the same restore six times fills the card. There is no time window, so old failures stay forever, and nothing records that someone has already looked at a failure.
- **Not actionable.** Every row is a link. You can't open an issue for a failure, acknowledge it, change an issue's status, or start a backup from Home.
- **Rigid layout.** A 2×2 grid of equal cards. An empty "Running now" card takes as much space as a full one, and long titles are truncated with no way to read them.
- **Not role-aware.** The only adaptation is card order, picked from the org role (`ORDER_OPS` / `ORDER_WORK`). A QA, a PM, and a developer with the same org role see the same page.
- **Stale and serial.** "Running now" is a snapshot taken at render time, although an SSE stream (`ActiveRunsProvider`) is already mounted in the app shell. All four queries sit in one `Promise.all`, so the slowest one holds back the whole page. `listAssignedIssues` filters by status in JavaScript and has no limit.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Layout | Main column + right rail (option A). Main: Needs attention, My issues. Rail: Running, Jump back in |
| Role adaptation | Data-driven. Sections show, hide, or reorder based on the user's data and permissions. No new job-role field and no user customisation |
| Failure noise | Group failures by (environment, kind). Auto-resolve a group when a later run with the same key succeeds. 7-day window |
| Acknowledge | Global (one person acks it for everyone) and recorded: who and when on `runs`, plus an `activity_log` entry |
| Actions on Home | Create an issue from a failure, acknowledge a failure group, change issue status inline, New issue, quick DB backup |
| Architecture | RSC shell with one `<Suspense>` per section. Small client islands. Server actions for mutations. No TanStack Query |
| Out of scope | One-click run retry (runs don't store structured parameters), customisable widgets, job-role field, KPI strip |

## Data and schema

### Migration `drizzle/20261004000000_home_ack`

On `runs`:

- `acknowledged_at timestamp null`
- `acknowledged_by_id uuid null`, references `users.id`, `on delete set null`
- Partial index `runs_attention_idx` on `(environment_id, kind, run_at desc) where status = 'failed' and acknowledged_at is null`

No new table.

### Permission

Add the project statement `run: ["acknowledge"]` in `lib/permissions.ts`. Grant it to `contributor` and `maintainer`, not to `viewer`. It is a separate statement from `database: ["backup"]` because the failing runs can be restores, mock-time changes or tests, not only backups.

### Attention key

`attentionKey(run) = run.kind ?? run.description`. Legacy runs with a null `kind` still group, using their description.

### `getAttentionGroups()` — `lib/home/queries.ts`

One SQL query (CTE with `DISTINCT ON` or a window function), scoped with `projectIdsWhere()`. A group `(environment_id, attention key)` is returned only when **all** of these hold:

1. It has at least one run with `status = 'failed'`, `acknowledged_at is null` and `run_at >= now() - interval '7 days'`.
2. No run with the same key in the same environment has `status = 'success'` and a `run_at` later than the group's latest failure.

Each group returns:

- The latest failed run: `id`, `description`, `errorMessage`, `runAt`, `kind`.
- `count`: the number of unacknowledged failures in the window.
- `environmentId`, the environment name, and the path `/{projectKey}/{envSlug}`.
- `canAcknowledge`: whether the caller has `run:acknowledge` on the environment's project.

Ordered by latest failure, newest first. Limit 8.

### `acknowledgeAttentionGroup(environmentId, key)` — `actions/home.ts`

- Validates `environmentId` as a uuid and checks `requireProjectPermission({ environmentId }, { run: ["acknowledge"] })` before any lookup.
- Sets `acknowledged_at = now()` and `acknowledged_by_id = me` on every failed, unacknowledged run in the group with `run_at <= now()`.
- Writes `activity_log` action `run.acknowledged` with `{ environmentId, key, runIds }`.
- Returns the acknowledged run ids so the Undo toast can call `unacknowledgeRuns(runIds)`. That action uses the same permission check and clears only rows that the caller's ack set.
- A failure after the ack makes the group appear again, with `count` starting from 1.

### `listMyOpenIssues(limit = 8)` — replaces the Home use of `listAssignedIssues`

- `where assignee_id = me and status in ('open', 'in_progress')`, done in SQL.
- Order: `in_progress` first, then `updated_at desc`.
- Returns the rows plus a `total` count, used for the "View all (N)" link to `/issues?mine=1`.

### `listRecentEnvironments(limit = 5)`

- A small query on `environment_access` for the current user, ordered by `last_accessed_at desc`, scoped by project access.
- Returns the name, project name, path, `hasDatabase` (the environment has a `db` service), and `canBackup` (`database:backup` on the project).
- Replaces fetching all of `listEnvironments()` and slicing it.

### Running

No new query. The rail reads `useActiveRuns()` from the existing `ActiveRunsProvider`.

## Role adaptation — `sectionOrder()`

`sectionOrder({ hasOpsAccess, attentionCount, issueCount })` is a pure function in `lib/home/layout.ts`. It returns the main-column sections in order, each with a display mode of `full`, `compact` (a single thin line) or `hidden`.

- `hasOpsAccess` is true when the user holds `run:acknowledge` in at least one project, or has an org role that bypasses project scope.
- **Needs attention**
  - `hidden` when `!hasOpsAccess && attentionCount === 0`.
  - `compact` ("All clear") when `hasOpsAccess && attentionCount === 0`.
  - Otherwise `full`.
- **My issues** is `compact` ("Nothing assigned") when `issueCount === 0`, otherwise `full`.
- **Order:** Needs attention comes first when `attentionCount > 0 && (issueCount === 0 || hasOpsAccess)`. Otherwise My issues comes first.
- The rail is always: Running, then Jump back in. Running is `compact` when nothing is running.

This replaces `ORDER_OPS` / `ORDER_WORK` and the literal `order-N` classes.

The counts come from the section queries. To avoid running them twice, `page.tsx` starts all three main queries as un-awaited promises. It awaits only the two counts that `sectionOrder` needs (cheap `count(*)` queries) and passes each list promise to its section. The section unwraps it inside its own `<Suspense>` with React's `use()`.

## Components

```
app/[locale]/(home)/
  page.tsx                 shell: header, main/rail grid, <Suspense> + error boundary per section
  loading.tsx              skeleton for layout A
  _components/
    home-header.tsx        greeting + "New issue" button (client, opens dialog)
    home-section.tsx       card wrapper with full/compact modes and the shared header (icon, title, count, link)
    attention-section.tsx  server; renders <AttentionList>
    attention-list.tsx     client; useOptimistic ack, Undo toast, "Issue" button
    my-issues-section.tsx  server; renders <MyIssuesList>
    my-issues-list.tsx     client; inline status select, optimistic
    running-rail.tsx       client; useActiveRuns(), live elapsed time, refresh on completion
    recent-envs-section.tsx server; links + <BackupButton>
    backup-button.tsx      client; createDatabaseBackup + toast
lib/home/queries.ts        getAttentionGroups, listMyOpenIssues, listRecentEnvironments, counts
lib/home/layout.ts         sectionOrder, greetingKey, attentionKey, failurePrefill (pure, unit-tested)
actions/home.ts            acknowledgeAttentionGroup, unacknowledgeRuns
components/issue-create-dialog.tsx   extracted from issues-client.tsx
```

### `IssueCreateDialog` extraction

`CreateIssueDialog` (in `app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx`, around line 567) moves to `components/issue-create-dialog.tsx`, and the issues page imports it from there. Behaviour on the issues page stays the same. The extracted dialog adds:

- An optional project/environment picker, shown when no environment is fixed. It defaults to the most recently accessed environment where the user has `issue:write`.
- Optional `defaults` (`title`, `description`, `type`).

### Interactions

- **Header.** Greeting from the browser's local hour (`greetingKey(hour)`: morning, afternoon, evening, night) with the user's first name. The **New issue** button opens `IssueCreateDialog` with the picker.
- **Attention row**
  - Shows the kind icon, then "Kind · Environment", a `×N` badge when N > 1, and the relative time.
  - Clicking the row opens the environment's history page. The full error message shows in a tooltip on hover.
  - **Issue** opens `IssueCreateDialog` prefilled by `failurePrefill(group)`:
    - type `bug`;
    - title `"<Kind> failed: <environment>"`;
    - description with the error message (truncated to 2,000 characters) and a link to the run log;
    - the environment preselected.
  - **Ack** removes the row at once (`useOptimistic`), calls the action, then refreshes. The sonner toast has an **Undo** button. Ack is shown only when `canAcknowledge`.
- **My issues row**
  - Shows the key, the title (with the full title as a tooltip), the project, and a status select (Open / In progress / Resolved / Closed) that calls the existing `setIssueStatus`, optimistically.
  - Rows set to resolved or closed fade and drop out on refresh.
  - The footer reads "View all (N)".
- **Running rail**
  - Live list from SSE: environment, description and elapsed time. Clicking opens the existing live run dialog.
  - When the number of active runs goes down, it calls `router.refresh()` once, so attention and recent environments pick up the finished run.
- **Jump back in.** Environment links. A **Backup** button appears only when `hasDatabase && canBackup`. It calls `createDatabaseBackup`, and the new run then shows in the rail through SSE.

### Visual

- Existing shadcn `Card`, `Badge`, `Select`, `Tooltip` and `Empty` components.
- Grid `grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]`. On small screens the rail stacks below the main column.
- Compact sections render as a single muted line inside a thin bordered row, not a full-height card.
- Long text is truncated with a tooltip showing the full value.

### i18n

All strings move to a new `home` namespace, replacing `inbox`, in all five `messages/{en,id,es,zh,ar}.json`. Remove `inbox` keys that are no longer used.

## Error handling

- Each section has its own error boundary. A failed query shows "Couldn't load · Retry" inside that card, and the rest of the page still renders.
- Action failures show as sonner toasts, and the optimistic state rolls back.
- Permission failures on ack or backup (for example, a role changed while the page was open) show as an error toast.

## Testing

The repo only has unit tests (`bun test`, happy-dom, a dummy `DATABASE_URL`), with no database in tests.

- **`tests/home-layout.test.ts`** (written first, TDD):
  - `sectionOrder`: every branch of the visibility and order rules.
  - `failurePrefill`: long error text, null `kind`, null `errorMessage`.
  - `greetingKey`: hour boundaries.
  - `attentionKey`: kind versus description fallback.
- **`tests/permissions.test.ts`:** `run:acknowledge` is granted to contributor and maintainer and denied to viewer.
- **Guard test**, following `tests/authz-guards.test.ts`: `acknowledgeAttentionGroup` and `unacknowledgeRuns` reject invalid ids and callers without permission before any lookup.
- **Manual SQL verification** against the dev database with a `bun` script, seeding these cases:

  | Seeded runs | Expected |
  |---|---|
  | 6 failed restores, same environment | 1 group, ×6 |
  | Failure, then a later success | No group |
  | Failure older than 7 days | No group |
  | Acknowledged failure | No group |
  | Acknowledged, then a new failure | Group, ×1 |
  | Legacy `kind = null` runs | Grouped by description |

  Check `EXPLAIN` uses `runs_attention_idx`.
- **Gate before done:** `bun test`, `bun run typecheck`, `bun run lint`. Then run the app and screenshot Home for three profiles: ops (failures present), developer (issues, no attention access), and an empty account.

## Rollout

- The migration only adds columns and an index, and existing rows keep `acknowledged_at` null. Apply it to the live DB following the documented VPN + SSH procedure, with a backup taken first.
- No feature flag. The new page replaces the old one in a single deploy.
