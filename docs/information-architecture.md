# Information Architecture & Page Structure

**Status:** Design reference (target state) · **Last updated:** 2026-07-11

This document describes the ideal page structure for OpsDeck as a shared
delivery + ops hub serving five personas — PM, BA, QA, Developer, DevOps —
without overengineering. It is the north star the current app evolves toward,
not a description of what exists today (see [Current state vs ideal](#current-state-vs-ideal)).

## Principles

1. **One app, one IA.** No per-persona apps or dashboards. Roles change the
   *default landing route* and *saved views*, not the pages themselves.
2. **Stable entity spine.** `Project → Environment → Service`. Issues,
   Knowledge, and Activity are cross-cutting and attach at any level without
   schema churn.
3. **Navigate by search, not by clicking.** The command palette (⌘K) and an
   Inbox absorb navigation growth so the sidebar stays short as scope grows.
4. **Human, shareable URLs** keyed by slug (`/CMEM/prod/databases`).
5. **Personalize with views, not pages.** New personas cost a saved view and a
   default landing, never a new screen.

## Personas

| Persona | Primary need | Default landing | Lives in |
|---|---|---|---|
| **PM** | What needs me, cross-project status | Home / My Work | Issues (board), Project overview, Activity |
| **BA** | Specs, runbooks, requirements | Knowledge | Knowledge, Issues, Project overview |
| **QA** | Report bugs, exercise a test env | My Work (assigned) | Issues, their Environment, Mock time, Databases, Backup/Restore |
| **Developer** | Ship + debug a deployment | My Work | Environment (dev), Services, Logs, Databases, Issues |
| **DevOps** | Infra health, backups, servers | Activity / Infrastructure | Servers, Storage, all Environments, Backups |

The IA is identical for all five. Only the entry point differs.

## Sitemap

Three navigation tiers: global (org), project, environment.

### Global (org sidebar)

```
├─ Home / Inbox        default landing — assigned to me, mentions, failed jobs, running now
├─ My Work             cross-project issues by status (may fold into Home)
├─ Projects            grouped by client → project overview
├─ Issues              all issues, saved views (board / table / filters)
├─ Knowledge           global KB / runbooks
├─ Activity            org-wide run + audit feed (backups / restores / deploys)
├─ Infrastructure      Servers, Storage                     (devops / admin)
├─ Users               (admin)
└─ Settings            branding, roles, integrations
```

### Project — `/[projectKey]`

```
├─ Overview            health: env summary, open issues, recent activity, pinned docs
├─ Environments        the deployments grid
├─ Issues              project issues (board / table, optional milestones)
├─ Knowledge           project-scoped docs
├─ Activity            project run history
└─ Settings            members, key / client, danger zone
```

### Environment — `/[projectKey]/[env]`

```
├─ Dashboard           db / backend / frontend status, last backup / restore / mock, activity
├─ Services            start / stop / restart, health
├─ Databases           list, create / drop
├─ Backups & Restore   history + restore flows
├─ Mock time           clock control
├─ Logs                streaming
├─ History             env run log
└─ Settings            servers, kind, owner, danger zone
```

### Cross-cutting (always available)

- **Command palette (⌘K)** — primary navigation. Jump to any project /
  environment / issue / doc, and run actions ("backup CMEM prod", "new issue").
- **Inbox / notifications** — assignment, job done, backup failed, mention.
- **Breadcrumb + switchers** — `Project › Environment › Section`.

## URL scheme

| Level | Pattern | Example |
|---|---|---|
| Global | `/<section>` | `/issues`, `/knowledge` |
| Project | `/<projectKey>` | `/CMEM` |
| Environment | `/<projectKey>/<envSlug>` | `/CMEM/prod` |
| Env section | `/<projectKey>/<envSlug>/<section>` | `/CMEM/prod/databases` |

Keys are uppercase and stable (also the issue-key prefix: `CMEM-42`). Env slugs
are lowercase and unique within a project. All URLs are shareable and readable.

> Note: the app today routes environments by UUID (`/projects/[envId]`). The
> key/slug scheme above is the target; migrating to it is a route refactor, not
> a data change.

## Roles

Keep to four, ordered by capability. Personas map onto these; capabilities gate
actions (who may restore a DB, delete a project, edit servers). Do **not** build
a per-permission matrix.

```
viewer  →  member  →  maintainer  →  admin
```

- **viewer** — read issues, knowledge, dashboards.
- **member** — create/edit issues, edit knowledge, run non-destructive ops.
- **maintainer** — restore/backup, manage environments, mock time.
- **admin** — servers, storage, users, project create/delete, org settings.

Each role has a **default landing route** (see persona table) so the app greets
each user with their work.

## Future-proofing

- The entity spine (`Project → Environment → Service`) is stable; new cross-cutting
  concerns (issues, knowledge, activity, later: deploys, incidents) attach at any
  level without reshaping it.
- One **activity/audit event stream**, filtered per scope, feeds notifications,
  history pages, and compliance — add event types, not new subsystems.
- **Saved views + role defaults** scale to new personas for free.
- **⌘K + Inbox** keep the sidebar short as sections multiply.

## Anti-overengineering

Explicitly out of scope until a concrete need forces them:

- ✗ Separate per-persona apps or a custom dashboard builder → one IA + role defaults.
- ✗ Full ITSM / Jira clone (workflow engine, custom-field builder, SLAs) →
  simple issues: status, assignee, labels, optional milestone.
- ✗ Sprints / roadmap / Gantt → start with board + optional milestones.
- ✗ Deep org hierarchy (org → team → project → …) → `client` stays a label until
  real per-client access control is required.
- ✗ Realtime everything → stream only logs and running jobs; the rest is
  request/refresh.

## Current state vs ideal

Have today:

- ✅ Entity spine `Project → Environment → Service`.
- ✅ Issues — project-scoped and global (`/issues`), table + board views.
- ✅ Environments grid grouped by project; project overview (`/project/[key]`).
- ✅ Knowledge base (global).
- ✅ Command palette (⌘K); two-level breadcrumb + env switcher.
- ✅ Per-environment History; Servers, Storage, Users (admin).
- ✅ **Home / Inbox** default landing at `/` (assigned to me, running now, recent
  failures, jump back in). Projects list moved to `/projects`.

Gaps to reach the ideal:

- ⚠️ **Notifications** (assignment, job done/failed, mention) feeding the Inbox.
- ⚠️ **Saved views / filters** for issues.
- ⚠️ **Project-scoped Knowledge** tab (KB is global-only today).
- ⚠️ **Org-level Activity** feed (activity is per-env only).
- ⚠️ Issue **labels / milestones**, issue **detail view + comments**, assignee picker.
- ⚠️ Clean **role → default-landing** mapping.
- ⚠️ Key/slug **URLs** for environments (currently UUID).

## Suggested build order

1. ~~**Home / Inbox** — my work + what needs me.~~ ✅ Done.
2. **Notifications** feeding the Inbox (assignment, job failed).
3. **Issue depth** — detail view, comments, labels, assignee picker, saved views.
4. **Project-scoped Knowledge** tab + **org Activity** feed.
5. **Role → default landing** and capability gates.
6. **Key/slug URL** migration for environments (cosmetic; do last).
