# Who triggered an auto-deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-deploys show who triggered them — the person who pushed (or pressed merge) on the forge — instead of "Unknown"; build rows also show the head commit's author email and message.

**Architecture:** When a build notification arrives, the Panel asks the component's CI connection for that pipeline (Woodpecker `GET /api/repos/<repoId>/pipelines/<number>`, number parsed from the notified `pipelineUrl`) and stores the pusher login, commit author email and commit message on the build. Auto-deploy runs created from that build carry the pusher as `runs.triggered_by` (free text, shown when the run has no Panel user). No repo or hook-contract change. A one-off CLI backfills existing builds and auto runs.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle (hand-written SQL migration), Vitest, Biome.

**Spec:** owner decision 2026-11-05 — "By" for auto-deploys = the pusher; commit author visible in build details. Woodpecker v3.20.1 facts (source `server/forge/bitbucket/convert.go`): for Bitbucket pushes `pipeline.sender` = `pipeline.author` = the pushing actor's login; `pipeline.author_email` = the head commit's git author email; `pipeline.message` = commit message.

## Global Constraints

- The hook contract (`POST /api/deploy-hooks/builds`, body `{app, branch, tag, commit, pipelineUrl?}`) does not change; pipelines in the seven repos are not edited.
- Enrichment is best-effort: a CI API failure, timeout (5 s), missing/unknown `pipelineUrl` or a pipeline URL whose repo id ≠ the component's `ci_repo_id` stores nulls and never fails or delays the hook response beyond the timeout; the build and its auto deployments are recorded exactly as today.
- `runs.triggered_by` is display text (max 200 chars), never used for authorization. A run with a Panel `user_id` keeps showing that user.
- Commit message stored truncated to 500 characters (first line shown in tables).
- Migration additive, `BEGIN; … COMMIT;`, applied before the build.
- English for code/comments/commits; UI strings in all five `messages/*.json` (en, id translated).
- `bun run typecheck`, `bun run lint`, `bun run test` green before each commit.

## Review Focus

1. A Woodpecker outage during a build notification must still record the build and queue/hold auto deployments, with `pushed_by` null and "By" showing "auto".
2. A `pipelineUrl` pointing at another repo id (or another host) must not be used to fetch someone else's pipeline data.
3. Held deployments (deploy lock) released later must carry the same `triggered_by` on the run created at release.

---

### Task 1: Schema, CI provider call, enrichment on notify

**Files:**
- Create: `drizzle/20261105040000_build_actors/migration.sql`
- Modify: `lib/db/schema.ts` (`builds.pushedBy`, `builds.commitAuthorEmail`, `builds.commitMessage`, `runs.triggeredBy` — all `text` nullable), `lib/ci/types.ts` + `lib/ci/woodpecker.ts` (`getPipeline(ciRepoId: string, number: number): Promise<{ sender: string | null; authorEmail: string | null; message: string | null }>`), `server/services/deploy-builds.ts` (`recordBuild` enriches before insert), `lib/deploy/repository.ts` (`placeDeployment` and `releaseLockIn` set `runs.triggered_by` from the build for `auto` runs)
- Test: `tests/build-actors-migration.test.ts`, `tests/ci-woodpecker.test.ts`, `tests/deploy-hooks.test.ts`, `tests/deploy-repository.test.ts`

- [ ] Step 1: failing tests — static migration (additive, four columns); `getPipeline` URL and mapping (sender, author_email, message; 404 → nulls; error → CiProviderError); `parsePipelineNumber(url, ciRepoId)` accepts `https://ci.dssconsulting.id/repos/2/pipeline/7` for ci_repo_id `2` → 7 and rejects another repo id, a non-numeric number or a missing URL (null) (Review Focus 2); `recordBuild` stores the fetched fields, stores nulls on provider failure/timeout and still requests auto deployments (Review Focus 1); auto run gets `triggered_by = sender`; a held deployment released later gets the same on its new run (Review Focus 3).
- [ ] Step 2–4: FAIL → implement → PASS; apply the migration on a scratch copy prepared by the controller (`actors-scratch`).
- [ ] Step 5: Commit `feat(deploy): record who pushed the build behind an auto-deploy`

### Task 2: Display and backfill

**Files:**
- Modify: `web/routes/$locale/_app/-components/env/history-client.tsx`, `web/routes/$locale/_app/-components/env/deploys/deploys-client.tsx` (and the server queries feeding them: return `triggeredBy` and build commit fields), messages
- Create: `scripts/backfill-build-actors.ts` (added to `build:ops` in `package.json`, run as `docker exec opsdeck-app bun dist/backfill-build-actors.js [--dry-run]`)
- Test: `tests/backfill-build-actors.test.ts`, existing history/deploys tests

- [ ] "By" column: Panel user when `userId` is set; else for auto runs `auto · <triggeredBy>` (muted, with a forge icon) when `triggeredBy` is set; else today's text. Recent builds rows: tooltip/secondary line with commit author email and the first line of the commit message.
- [ ] Backfill CLI: for builds with null `pushed_by` and a parsable `pipelineUrl`, fetch through the component's connection (sequential, 5 s timeout each, skip on error), update the build, then set `triggered_by` on auto runs linked via `deployments.build_id` where `runs.user_id` is null and `triggered_by` is null; prints counts only; `--dry-run` writes nothing.
- [ ] Tests for the display rule (pure function `runActorLabel(run)`), and the backfill against a mocked provider/db (dry run writes nothing; idempotent second run).
- [ ] Commit `feat(deploy): show who triggered auto-deploys; backfill existing builds`

### Task 3: Go live (controller)

- [ ] Backup, dry-run, apply the migration; merge, push; Romi runs Jenkins `DSS/dss-panel`; health 200.
- [ ] `docker exec opsdeck-app bun dist/backfill-build-actors.js --dry-run`, then without `--dry-run`; check Sucor Membership / Dev 2 History shows "auto · <login>" for the 2026-11-04 19:06 deploy.
- [ ] Push a commit to `panel-canary`; the auto-deploy row shows the pusher.
