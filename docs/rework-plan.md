# Rework Plan: OpsDeck → 5-Role Delivery + Ops Hub

**Status:** In progress (Phases 0–4 shipped) · **Last updated:** 2026-07-11

Target: evolve OpsDeck from a DevOps-first control panel into a shared hub that
serves five personas — PM, BA, QA, Developer, DevOps — without turning it into a
Jira/TestRail clone.

## Progress

| Phase | Status |
|---|---|
| 0 — RBAC foundation | ✅ Shipped |
| 1 — Issue depth | ✅ Shipped |
| 2 — Board + My Work | ✅ Shipped |
| 3 — QA test management | ✅ Shipped (Option A, record-not-execute) |
| 4 — BA requirements + Activity | ✅ Shipped |
| 5 — Polish | ⬜ Not started |

**Migrations to apply before deploy** (additive, safe while running):
`20260711070000_project_members`, `20260711080000_issue_depth`,
`20260711090000_test_runs`, `20260711100000_kb_doc_type`,
`20260711110000_activity_log`.

**Deferred within shipped phases:** service-control capability tuning (Phase 0);
create-time parent picker, deep (>1-level) cycle guard, milestone filter on the
global view (Phase 1); global-view milestone swimlane — needs a milestone name on
`listAllIssues` (Phase 2).

## Guiding principles

- **Keep the spine.** `Project → Environment → Service` is canonical and stays
  untouched. Issues, Knowledge, and Activity are cross-cutting and attach at any
  level.
- **Reuse, don't build subsystems.** Test runs extend `runs`; requirements are a
  Knowledge doc type; issue attachments mirror `knowledgeAttachments`.
- **Each phase ships on its own.** No big-bang migration.
- **RBAC first.** Five roles on a flat `admin/member` model is the first thing
  that breaks. Everything else depends on it.

## What is already canonical (do not touch)

- Two-level `projects` → `environments` split.
- UUIDv7 IDs, fractional-index ranks, `tsvector` generated columns + GIN FTS.
- Notifications stored as `type` + `data` (rendered in the reader's locale).
- KB revisions + backlink graph.
- Next RSC + Drizzle + PG18 + better-auth + SSE streaming.

---

## Phase 0 — RBAC foundation (blocker) — ✅ Shipped

Problem: five personas on flat `users.role` (`admin`/`member`). No answer to
"who may restore a DB / delete a project / edit servers".

**Schema**

```
roleEnum = viewer | member | maintainer | admin      -- replaces users.role text
projectMembers (projectId, userId, role)             -- PK(projectId, userId)
```

- Global `users.role` is the capability floor; per-project `projectMembers.role`
  can raise it.
- Add `requireCapability(cap, projectId?)` to `lib/auth-session.ts`. Static
  role→capability map. **No permission-matrix builder** (overengineering).

**Capability map**

| capability | viewer | member | maintainer | admin |
|---|:-:|:-:|:-:|:-:|
| read | ✓ | ✓ | ✓ | ✓ |
| issue / KB edit |  | ✓ | ✓ | ✓ |
| backup / restore / mock time |  |  | ✓ | ✓ |
| servers / storage / users / project CRUD |  |  |  | ✓ |

**Risk:** medium — touches every action. **Effort:** 2–3 days. **Migration:**
enum + one table + backfill existing admins.

### Task breakdown

**Security finding driving this phase:** destructive ops (`restoreDatabaseBackup`,
`dropDatabase`, `renameDatabase`, `createDatabase`, and the mock-time clock
actions) are gated only by `requireSession()` today — any signed-in member can
restore or drop a production database. Phase 0 closes this.

Current model: two roles only (`ROLE_ADMIN` / `ROLE_MEMBER` in `lib/roles.ts`)
via the better-auth admin plugin. Binary gate: `requireAdmin` (servers, storage,
users, project CRUD, KB collections) vs `requireSession` (everything else,
including destructive DB ops).

**0.1 — Extend role constants** · `lib/roles.ts`, `lib/auth.ts`
- Add `ROLE_VIEWER`, `ROLE_MAINTAINER`. Order: `viewer < member < maintainer < admin`.
- Export `ROLE_RANK: Record<UserRole, number>` for capability comparison.
- Keep `users.role` as `text` (the better-auth admin plugin owns this column) —
  do not force it to a `pgEnum`; validate via constants in the action layer.

**0.2 — Membership table + enum** · `lib/db/schema.ts`
```
projectRoleEnum = pgEnum(viewer|member|maintainer|admin)
projectMembers {
  projectId uuid -> projects.id (cascade)
  userId    uuid -> users.id  (cascade)
  role      projectRoleEnum notNull
  PK(projectId, userId)
  index(userId)
}
```
Membership attaches to `projects` (logical), inherited by all its environments —
no environment-level granularity. Then `pnpm drizzle-kit generate`.

**0.3 — Capability resolver (core)** · `lib/auth-session.ts`
```
Capability = read | issue.edit | kb.edit | ops.destructive | admin
resolveRole(session, projectId?) = max(users.role, projectMembers.role) via ROLE_RANK
requireCapability(cap, projectId?) -> session | redirect
```
Static `cap → minRole` map (no matrix builder): read=viewer, issue.edit/kb.edit=member,
ops.destructive=maintainer, admin=admin. Keep `requireAdmin`/`requireSession` as
thin wrappers over `requireCapability` so existing callers don't break.

**0.4 — Gate destructive ops (security fix)** — swap `requireSession()` →
`requireCapability("ops.destructive", projectId)`:
- `actions/backups.ts`: `createDatabaseBackup`, `restoreDatabaseBackup`
- `actions/databases.ts`: `createDatabase`, `dropDatabase`, `renameDatabase`
- `actions/mock-time.ts`: `travelClock`, `freezeClock`, `advanceClock`, `resetClock` (+ legacy)

Read-only actions (`getBackupList`, `getClockState`, `getDatabaseList`) stay on
`requireSession`.

**0.5 — Membership CRUD + UI**
- New `actions/project-members.ts`: `list/add/updateRole/remove`, gated by
  `requireCapability("admin", projectId)`.
- Members tab in `app/[locale]/projects/[projectId]/settings/` — user picker + role
  dropdown, reusing the issue-assignee picker pattern.

**0.6 — Hide actions in UI by capability**
- Pass `effectiveRole` to the client via the layout/page.
- Gate buttons: Restore/Backup/Drop/Mock (maintainer), Members/Settings (admin),
  across `app/[locale]/projects/[projectId]/**`.

**PR split**

| PR | Tasks | Merges alone? |
|:-:|---|---|
| 1 | 0.1 + 0.2 + 0.3 | ✅ foundation, no behavior change |
| 2 | 0.4 | ✅ **security fix**, immediate effect |
| 3 | 0.5 + 0.6 | ✅ membership UI |

PR-2 is small but the most important — cherry-pick it first, ahead of the UI work.

---

## Phase 1 — Issue depth (PM + Developer) — ✅ Shipped

Issues are flat today. Make them usable without becoming Jira.

**Add columns to `issues`**

```
type        issueTypeEnum(bug|task|story|epic)  default 'task'
priority    priorityEnum(low|med|high|urgent)   default 'med'
parentId    uuid -> issues.id (set null)        -- subtask / epic child
estimate    integer null                        -- story points, optional
milestoneId uuid -> milestones.id (set null)
```

**New tables**

```
milestones (id, projectId, name, dueAt, closedAt)
issueAttachments                                -- 1:1 copy of knowledgeAttachments
```

- `parentId` self-FK gives epic → story → subtask with one column, not a
  hierarchy table.
- Milestone ≠ `environmentKind=release` (planning vs deployment; distinct).

**Risk:** low (additive). **Effort:** 2 days + UI pickers.

---

## Phase 2 — Board + My Work (PM + QA + Developer) — ✅ Shipped

**Pages**

- Global Issues: add a **kanban board by status**, optional swimlanes by
  assignee/milestone. List and grid already exist — board is a third view.
- **Role-adaptive Home** (not a new page):
  - PM → cross-project open issues + milestones due
  - QA → assigned + `environmentKind=qa`
  - Developer → assigned issues + dev environment
  - DevOps → failed runs + running now (today's Home)
- Default landing derived from `users.role` (Phase 0).

**Reuse:** `savedViews` already exists → role defaults are savedView presets. No
new schema.

**Risk:** low. **Effort:** 3–4 days (UI-heavy).

---

## Phase 3 — QA test management (QA) — ✅ Shipped (Option A)

**Shipped as record-not-execute.** QA records a Pass/Fail result (+ note) against
the issue's environment on the issue detail; it becomes a `run` (kind=`test`,
status success/failed) linked back to the issue, reusing the runs history/infra.
The issue must be pinned to an environment (runs are environment-scoped). Actual
suite *execution* (a per-environment test command + worker job, with log
streaming) is deferred until a concrete need — Option B below.


Do not build TestRail. Extend the `runs` infrastructure (already has SSE / log /
status).

**Option A (minimal, recommended)**

```
runKindEnum + runs.kind (backup|restore|mock_time|test)
runs.issueId uuid -> issues.id (set null)       -- link a test result to a bug
```

A test is a run that executes a suite against an environment; log streaming
comes for free.

**Option B (only if reusable test cases are needed)**

```
testCases (id, projectId, title, steps, expected)
testRuns  (id, testCaseId, environmentId, status, runId?)
```

Start with A. Move to B only when QA asks for a case library.

**Risk:** low. **Effort:** A = 1 day, B = +2 days.

---

## Phase 4 — BA requirements + Activity stream — ✅ Shipped

**Activity events wired so far:** `issue.created`, `issue.status_changed`,
`milestone.created`, `test.recorded`, `member.added`, `member.removed`. Adding a
new event = a `recordActivity` call at the mutation site plus one i18n template —
no schema change. Ops-run events (backup/restore/mock completion) are the obvious
next additions; deferred.


**BA — no new tables**

- Add a `type` enum to `knowledgeDocuments` (`doc|runbook|spec|requirement`);
  link to issues via existing `projectId` / body backlinks.
- Acceptance criteria = a markdown checklist in the doc. KB already has
  revisions + FTS.

**Activity / audit (DevOps + compliance)**

```
activityLog (id, actorId, scope, entityType, entityId, action, data jsonb, at)
```

- One stream. `runs` stays for jobs, but `activityLog` captures everything
  (issue moved, member added, restore triggered).
- Filter per scope → feeds notifications, history pages, and compliance. **Add
  event types, not new subsystems** (future-proof).

**Risk:** low. **Effort:** 2 days.

---

## Phase 5 — Polish (cosmetic, last)

- **Key/slug URLs:** `/CMEM/prod/databases` instead of `/projects/[uuid]`. Route
  refactor, not a data change. `projects.key` + an env slug are the raw material.
- Command palette: from navigation → **actions** ("backup CMEM prod",
  "new issue").
- Bulk actions + keyboard-first (j/k/x) in the issue list.
- `@mention` in comments → extend `notificationTypeEnum`.

**Risk:** low, but the URL migration touches many links. **Effort:** 3 days.

---

## Order and rationale

| Phase | Content | Why this order |
|:-:|---|---|
| 0 | RBAC | everything else depends on it |
| 1 | Issue depth | additive; unlocks PM + Developer |
| 2 | Board + My Work | consumes Phase 0 + 1 |
| 3 | Test runs | reuses `runs`; independent |
| 4 | BA + Activity | zero / one new table |
| 5 | URL + palette polish | cosmetic; no rush |

Phases 0–2 deliver ~80% of the value (PM + Developer + QA become usable). Phases
3–5 are demand-driven. Rough total: 3–4 weeks for one developer.

## Explicitly out of scope (anti-overengineering)

- ✗ Sprints / Gantt / roadmap → board + milestones are enough.
- ✗ Permission-matrix builder → static role→capability map.
- ✗ Workflow / custom-field engine → enums.
- ✗ Org → team → project hierarchy → `client` stays a label.
- ✗ Realtime everything → stream only logs and running jobs.
