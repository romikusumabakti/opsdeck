# Owner deploy lock (plan 3a.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An environment's owner (typically the QA who tests it) or a maintainer can lock deploys with a reason and an expiry; while locked, manual deploys and rollbacks are refused and auto-deploys are held; on unlock (or expiry) the newest held build of each target is deployed; an admin can force-unlock with an audited reason.

**Architecture:** One row per locked environment (`environment_deploy_locks`) and a new deployment status `held`. Deploy requests consult the lock; auto requests become `held` deployments that supersede older held ones per target. Unlocking — by the user, by an admin, or by a repeatable worker sweep when the lock expires — turns the newest held deployment per target into `queued` and enqueues it. Also closes two items parked by plan 3a's final review.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle (hand-written SQL migrations), BullMQ repeatable jobs (`lib/queue.ts`, pattern `scheduleJiraSweep`), Zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md` — owner decision 2026-11-05: QA do not deploy (developers are project maintainers); the owner can block deploys on their environment via a lock. Builds on plan 3a (`docs/superpowers/plans/2026-11-05-variables-and-access.md`, same branch, not yet live).

## Global Constraints

- Who may lock: the environment's owner (`environments.owner_id`, any project role ≥ viewer) and project maintainers. Who may unlock: the user who locked and the environment's owner only — maintainers cannot unlock a lock they did not set (owner decision 2026-11-05). Force-unlock with a reason: org admins only (`integration:manage`), recorded in the activity log. Nobody else.
- A lock has a reason (1–200 chars) and an expiry; default expiry = 17:00 Asia/Jakarta today, or now + 2 h when it is already past 16:00 Asia/Jakarta; maximum 7 days ahead. Timestamps stored UTC (Panel convention).
- While locked: manual deploys and rollbacks → 409 with the lock's holder, reason and expiry in the message (translated); auto deploys → status `held` (not run), and a new held deployment supersedes older held auto deployments of the same target.
- On unlock/expiry: per target of the environment, the newest held deployment becomes `queued` and is enqueued; older held ones are `superseded`. Nothing is run for targets with no held deployment.
- An expired lock is released by a worker sweep running every 60 s; a lock past its expiry no longer blocks requests even before the sweep runs.
- Ruling (final review): setting a lock stops deployments that have not started — the environment's queued `auto` deployments become `held` (their never-started runs are deleted) and queued `manual` deployments and rollbacks are cancelled (status `failed`, run failed with "Cancelled: deploys locked by <name> — <reason>", nothing more). `claimDeployment` re-reads the lock `FOR SHARE` and applies the same rule to anything it would claim while locked (outcomes `held` / `cancelled`, which the worker treats as done).
- Ruling (final review): `placeDeployment` releases an expired, unswept lock (cause `expired`, same semantics as the sweep) in its own transaction before placing, so held builds are queued before the new request.
- Lock order: every transaction that changes deployments under the lock touches the `environment_deploy_locks` row before any `deployments` row, and never upgrades a `FOR SHARE` lock row to a `DELETE` (two such holders deadlock).
- Every lock, unlock, force-unlock and expiry release writes an activity entry.
- Migrations additive (`ALTER TYPE … ADD VALUE` is fine), `BEGIN; … COMMIT;` where Postgres allows; applied before the build.
- English for code/comments/commits; UI strings in all five `messages/*.json` (en, id translated).
- `bun run typecheck`, `bun run lint`, `bun run test` green before each commit.

## Review Focus

1. A build notification arriving while locked must produce a `held` deployment and never a run — including when two notifications for the same target arrive within the same second.
2. Unlock must not start two deployments for the same environment at once (the existing one-running-per-environment index) — queued deployments of several targets are claimed one after another as today.
3. A lock that expired while the worker was down is released on the next sweep after restart, and its held builds deploy.
4. A user who is only `viewer` and not the owner cannot lock or unlock; the owner losing ownership loses lock rights immediately (a lock they already set stays until unlock/expiry).
5. Force-unlock without a reason, or by a maintainer, is refused; a maintainer cannot DELETE a lock set by the owner.

---

### Task 1: Schema and lock rules

**Files:**
- Create: `drizzle/20261105030000_deploy_locks/migration.sql`, `lib/deploy/lock.ts`
- Modify: `lib/db/schema.ts`
- Test: `tests/deploy-lock-migration.test.ts`, `tests/deploy-lock-rules.test.ts`

**Interfaces:**
- Produces: `deploymentStatusEnum` gains `held`; table `environment_deploy_locks` (`environment_id uuid pk → environments.id on delete cascade`, `locked_by uuid null → users.id on delete set null`, `reason text not null`, `expires_at timestamp not null`, `created_at timestamp not null default now()`); `lib/deploy/lock.ts`: `defaultLockExpiry(now: Date): Date`, `lockExpirySchema` (must be > now and ≤ now + 7 d), `isLockActive(lock: { expiresAt: Date } | null, now: Date): boolean`, `canLock(role: ProjectRole | null, isOwner: boolean): boolean`, `canUnlock(isOwner: boolean, isLocker: boolean): boolean` (true iff owner or locker).
- [ ] Step 1: failing tests — migration static (ADD VALUE 'held', table, cascade, no DROP); `defaultLockExpiry` at 09:00 WIB → 17:00 WIB same day, at 16:30 WIB → 18:30 WIB, at 23:00 WIB → 01:00 WIB next day; expiry 8 days ahead rejected; `isLockActive` false at/after expiry; permission matrix (viewer non-owner false; viewer owner true; maintainer true; null role false).
- [ ] Step 2–4: FAIL → implement → PASS; apply on the controller's scratch copy (`lock-mig-scratch`).
- [ ] Step 5: Commit `feat(db): environment deploy locks`

### Task 2: Lock API, deploy gating, held builds, release

**Files:**
- Create: `server/services/deploy-locks.ts`, `server/routes/deploy-locks.ts`
- Modify: `server/services/deployments.ts` (`requestDeployment`), `server/services/deploys.ts` (manual deploy, rollback), `lib/deploy/repository.ts` (held supersede, release), `lib/jobs/worker.ts` + `lib/queue.ts` (repeatable `deploy/lock-sweep`, every 60 s), `server/app.ts`
- Test: `tests/deploy-locks-api.test.ts`, `tests/deploy-hooks.test.ts`, `tests/deploys-api.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `GET /api/environments/:id/deploy-lock` (`deploy:view`; `{ lock: { lockedBy: {id,name} | null, reason, expiresAt } | null, heldCount }`), `PUT /api/environments/:id/deploy-lock` (`{ reason, expiresAt? }`; owner or maintainer), `DELETE /api/environments/:id/deploy-lock` (locker or owner only), `POST /api/environments/:id/deploy-lock/force-unlock` (`{ reason }`, org `integration:manage`); `releaseLock(environmentId, cause: "unlock" | "force" | "expired", actorId: string | null): Promise<{ queued: string[] }>` — deletes the lock and, in one transaction per target, turns the newest `held` into `queued` and older `held` into `superseded`, then enqueues the queued ones; `sweepExpiredLocks(now)`.
- `requestDeployment`: when an active lock exists — `manual`/`rollback` → 409 (message key `deploy.locked` with holder, reason, expiry); `auto` → insert with status `held` and supersede older held auto deployments of the target (reuse/extend `supersedeQueuedAuto`); do not enqueue.
- [ ] Step 1: failing tests for Review Focus 1–5 plus: manual deploy while locked → 409 with the lock message; held then unlock → exactly the newest held queued and enqueued, older superseded; expired lock does not block; sweep releases expired locks; activity entries for lock/unlock/force/expired.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(deploy): owner deploy lock with held auto-deploys`

### Task 3: UI

**Files:**
- Modify: env Deploys page (`web/routes/$locale/_app/-components/env/deploys/deploys-client.tsx`) and env dashboard header badge; `web/api/deploy-locks.ts` (new); messages
- Test: `tests/deploy-lock-messages.test.ts` (keys present in all locales, en ≠ id)

- [ ] Banner when locked: holder, reason, expiry (local time), held build count; buttons Lock (dialog: reason, expiry with the default prefilled) / Unlock / Force unlock (admins, reason required); Deploy and Rollback buttons disabled with the lock reason as tooltip; held deployments listed with a "Held" badge. Read `/var/home/romi/.claude/projects/-var-home-romi/memory/shadcn-2026-base-ui-metrics.md` first.
- [ ] Commit `feat(deploy): deploy lock controls`

### Task 4: Parked items from plan 3a

**Files:**
- Modify: `server/services/project-catalog.ts` (`removeProject`), `server/services/deploys.ts` (tag variable schema)
- Test: `tests/project-catalog.test.ts` (or the existing project delete test), `tests/deploys-api.test.ts`

- [ ] Project delete: refuse (409, translated) while any environment of the project has escrowed variables unless `confirmEscrowedDeletion: true`; record an activity entry per environment that had variables (names and count, never values).
- [ ] Tag variable names (deploy targets) reject the reserved prefixes `COMPOSE_`, `DOCKER_`, `BUILDKIT_`.
- [ ] Commit `fix: escrow guard on project delete, reserved tag variable names`

### Task 5: Go live 3a + 3a.1 (controller, after Romi's go-ahead)

- [ ] Probe the new conditional SQL (environment delete with escrow, project delete guard, held/release) against a port-mapped Postgres restored from the scratch copy.
- [ ] Run the real-SQL concurrency probe on a fresh copy of live (not the scratch copy): `placeDeployment` vs `releaseDeployLock` in both orders; two concurrent `auto` inserts for one target while locked; lock insert vs a claim of a queued deployment.
- [ ] Before any image rollback to a pre-3a.1 build: set held deployments to `superseded` (`UPDATE deployments SET status = 'superseded', finished_at = now() WHERE status = 'held';`) — the old code knows no `held` and would leave them stuck.
- [ ] Backup; dry-run and apply `20261105020000_variables_and_access` then `20261105030000_deploy_locks`; merge both plans' branch into `main`, push; Romi runs Jenkins `DSS/dss-panel`; health 200.
- [ ] Canary (plan 3a Task 7 steps on `panel-canary`, with `docker compose config --environment`), then: lock the canary environment, push a commit to `panel-canary` → the build is `held`; manual deploy refused; unlock → the held build deploys.
- [ ] Memory: opsdeck `panel-deploy-feature.md`, `db-migrations.md`.
