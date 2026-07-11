# Rework Plan: OpsDeck → 5-Role Delivery + Ops Hub

**Status:** Proposal · **Last updated:** 2026-07-11

Target: evolve OpsDeck from a DevOps-first control panel into a shared hub that
serves five personas — PM, BA, QA, Developer, DevOps — without turning it into a
Jira/TestRail clone.

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

## Phase 0 — RBAC foundation (blocker)

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

---

## Phase 1 — Issue depth (PM + Developer)

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

## Phase 2 — Board + My Work (PM + QA + Developer)

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

## Phase 3 — QA test management (QA)

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

## Phase 4 — BA requirements + Activity stream

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
