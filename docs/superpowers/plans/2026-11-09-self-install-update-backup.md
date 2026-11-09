# Self-install, Self-update and Self-backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opsdeck installs with one command, updates itself from GitHub Releases through a host updater with backup first and image rollback, and backs itself up to an S3 connection with restore from the UI. DSS runs a beta instance with sample data and moves production off Jenkins.

**Architecture:**
- **One CLI** (`opsdeck`) in the app image does migrate, backup, restore and seed. The app worker, the host updater and `install.sh` all call it.
- **The app never touches Docker.** It writes a request file into a bind-mounted `updates/` dir. A root systemd path unit runs a fixed POSIX `update.sh`.
- **Releases** are tag-driven GitHub Actions builds to GHCR, with a `release.json` asset.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle 1.0 rc (`drizzle-orm/postgres-js/migrator`), BullMQ/Valkey, `@aws-sdk/client-s3`, POSIX sh, systemd, Docker Compose v2, GitHub Actions (`docker/build-push-action`, `actions/attest-build-provenance`).

**Spec:** `docs/superpowers/specs/2026-11-09-self-install-update-backup-design.md`

## Global Constraints

- **Copy and errors:**
  - User-facing strings go in all 5 `messages/*.json`; `en` and `id` are real translations.
  - Error bodies keep a stable `code`.
- **No Docker in the app:** the app container gets no `docker.sock` and no host root. Its only host channel is `${dir}/updates/request.json`.
- **`SECRETS_KEY`** is never written into a backup, a release or a log.
  - `.env` is 0600 root.
  - Only `sha256(SECRETS_KEY)` truncated to 16 hex characters (the "fingerprint") may be stored or shown.
- **Images** are pinned by digest in `.env` (`name:tag@sha256:…`). Nothing uses `latest`.
- **Tags:**
  - stable is `vX.Y.Z`, beta is `vX.Y.Z-beta.N`;
  - the version is baked into the image as `OPSDECK_VERSION`;
  - the GHCR image is `ghcr.io/romikusumabakti/opsdeck`.
- **Migrations** run only through Drizzle's migrator from now on:
  - no `BEGIN`/`COMMIT` inside a file;
  - `SET LOCAL lock_timeout = '5s'` first;
  - expand/contract only (no drop or rename of anything the previous release reads).
- **Shell:** POSIX `sh` only (no bash-isms; `shellcheck -s sh` clean). Host requirements: systemd, Docker Engine, Compose v2, curl. No other runtime.
- **Defaults:**
  - backup daily at 02:30 in the instance time zone;
  - retention 14 daily + 8 weekly remote, 3 local;
  - update check hourly;
  - auto-update off (beta: on);
  - restore needs a typed confirmation.
- **Commits** are conventional, in English. Before each commit run `bun run check`, `bun run typecheck` and `env -u SECRETS_KEY bun run test`.

## Review Focus

1. **The app container is killed in the middle of an update.** The host run continues, and the UI shows the final status when it comes back. Task 6 test `status survives app restart`.
2. **A request file holds anything other than a known release version** (path, shell metacharacters, an older version than `minFrom`). The updater refuses it with status `refused`. Task 6 tests `rejects non-version request`, `rejects below minFrom`.
3. **The backup destination is unreachable or the credentials are wrong.** The run is recorded `failed` with a code, a Home attention item appears, the update aborts before pull, and the local copy is kept. Task 4 test `upload failure keeps local copy`, Task 6 test `backup failure aborts update`.
4. **The restore source was made by an older or newer version.**
   - Older: it restores under the manifest version and then updates.
   - Newer than any reachable release: it is refused.
   - Task 6 tests `restore pins manifest version`, `refuses newer backup`.
5. **The beta instance's seed runs twice.** It is idempotent: no duplicate projects or accounts, and existing account passwords are not reset. Task 9 test `seed is idempotent`.

---

## File Structure

- `lib/version.ts`: `OPSDECK_VERSION`, `compareVersions`, `parseVersion`, channel of a version.
- `drizzle/00000000000000_baseline/migration.sql` and `drizzle/legacy/…`: the squashed baseline; the old 53 folders are kept for reference and never run.
- `scripts/cli.ts`: the `opsdeck` CLI, with subcommands in `scripts/cli/{migrate,backup,restore,seed}.ts`.
- `lib/instance-backup/{manifest,retention,archive,destination}.ts`: the backup core (pure parts testable).
- `server/services/instance-backups.ts`, `server/routes/instance.ts`: Backups and Updates API.
- `web/routes/$locale/_app/admin.instance.tsx`: the Admin → Instance page (Updates and Backups tabs).
- `lib/updates/{releases,request}.ts`: the GitHub Releases check and request/status file I/O.
- `ops/install/{install.sh,update.sh,compose.yaml,env.example,opsdeck-updater@.path,opsdeck-updater@.service}`: the host side.
- `.github/workflows/release.yml`, `scripts/release-manifest.ts`: the release pipeline.

---

### Task 1: Version in the image and health

**Files:**
- Create: `lib/version.ts`
- Modify: `Dockerfile` (`ARG OPSDECK_VERSION=0.0.0-dev` → `ENV OPSDECK_VERSION`), `server/app.ts:82` (health)
- Test: `tests/version.test.ts`, `tests/health.test.ts`

**Interfaces:**
- Produces:
  - `OPSDECK_VERSION: string` (from env, default `"0.0.0-dev"`);
  - `parseVersion(v: string): { major; minor; patch; beta: number | null } | null`;
  - `compareVersions(a: string, b: string): -1 | 0 | 1` (semver order, so beta < stable of the same X.Y.Z);
  - `channelOf(v: string): "stable" | "beta"`.
  - `GET /api/health` → `{ ok: true, version: string }`.

- [ ] **Step 1: Write the failing tests.**
  - `parseVersion("v1.2.3-beta.4")` → `{1,2,3,beta:4}` (a leading `v` is accepted).
  - `parseVersion("1.2")` → `null`.
  - `compareVersions("1.2.3-beta.9","1.2.3")` → `-1`.
  - `compareVersions("1.10.0","1.9.9")` → `1`.
  - `channelOf("1.0.0-beta.1")` → `"beta"`.
  - Health returns the version from env.
- [ ] **Step 2: Run** `env -u SECRETS_KEY bun --bun vitest run tests/version.test.ts tests/health.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat: report the opsdeck version in health`.

### Task 2: Squash migrations into a baseline and run them with the migrator

**Files:**
- Move: `drizzle/2026*` → `drizzle/legacy/` (kept, never run).
- Create:
  - `drizzle/00000000000000_baseline/migration.sql` (and the `snapshot.json` drizzle-kit writes);
  - `scripts/cli.ts`;
  - `scripts/cli/migrate.ts`;
  - `tests/baseline-schema-scratch.test.ts` (opt-in via `BASELINE_SCRATCH_DB`, like `tests/environment-setup-scratch.test.ts`);
  - `tests/cli-migrate.test.ts`.
- Modify: `package.json` (`build:ops` also bundles `scripts/cli.ts` to `dist/cli.js`); `drizzle.config.ts` (out stays `./drizzle`; legacy is excluded).

**Interfaces:**
- Produces:
  - `opsdeck migrate` runs `migrate(db, { migrationsFolder: "drizzle" })`;
  - `opsdeck migrate --adopt` checks the live schema against the baseline, then inserts the baseline row into `drizzle.__drizzle_migrations` without running it; it refuses when the schema differs;
  - in the image: `bun dist/cli.js <cmd>`, with an `opsdeck` wrapper on `PATH`.

- [ ] **Step 1: Generate the baseline** with `bunx drizzle-kit generate --name baseline` against an empty `drizzle/` (with legacy moved out). Rename the folder to `00000000000000_baseline`. Append only the **generic** seed rows the legacy migrations insert, e.g. default labels from `20260711050000_labels`. Never append DSS-specific rows (zones, tunnels, servers, users).
- [ ] **Step 2: Write the scratch test** `baseline reproduces the legacy schema`:
  - Database A: apply every legacy migration in order with `psql -v ON_ERROR_STOP=1`.
  - Database B: run `opsdeck migrate`.
  - Compare normalised `pg_dump --schema-only --no-owner --no-privileges` output (comments and `SET` lines stripped, statements sorted). Expect equal.
  - It also asserts B's `drizzle.__drizzle_migrations` has 1 row.
- [ ] **Step 3: Write the unit tests** for `--adopt` (schema-diff function mocked):
  - `adopt refuses on schema difference`: exit code 2, message lists the first 20 differing lines, no insert;
  - `adopt records baseline`: inserts the hash drizzle computes for the baseline folder;
  - `adopt is a no-op when already recorded`.
- [ ] **Step 4: Run** `env -u SECRETS_KEY bun --bun vitest run tests/cli-migrate.test.ts` and `BASELINE_SCRATCH_DB=baseline_scratch env -u SECRETS_KEY bun --bun vitest run tests/baseline-schema-scratch.test.ts`. Expected: FAIL first, then PASS after implementing. The scratch DB lives in the local podman `opsdeck-postgres`.
- [ ] **Step 5: Update the docs.** In `README.md` "Database migrations", explain the migrator rules (Global Constraints) and that `drizzle/legacy` is history only.
- [ ] **Step 6: Commit:** `feat(db): squash migrations into a baseline run by the migrator`.

### Task 3: Instance settings and backup history schema

**Files:**
- Create: `drizzle/20261110000000_instance_backups/migration.sql` (migrator rules), `tests/instance-backups-migration.test.ts`
- Modify: `lib/db/schema.ts`

**Interfaces:**
- Produces these tables:
  - `instance_settings`, a single row keyed `id = 1`:
    - `backup_destination_id uuid null` → `s3_connections` on delete set null;
    - `backup_time text not null default '02:30'`;
    - `backup_keep_daily int default 14`, `backup_keep_weekly int default 8`;
    - `secrets_key_fingerprint text null`;
    - `update_channel text check in ('stable','beta') default 'stable'`;
    - `auto_update boolean default false`;
    - `auto_update_window text default '03:00'`.
  - `instance_backups`:
    - `id uuid uuidv7`, `started_at`, `finished_at null`;
    - `status` enum `instance_backup_status` (`running`, `succeeded`, `failed`);
    - `trigger` enum `instance_backup_trigger` (`schedule`, `manual`, `update`);
    - `version text`;
    - `location` (`s3` | `local`), `object_key text null`;
    - `size_bytes bigint null`, `error_code text null`;
    - `acknowledged_at null`.
  - Drizzle exports: `instanceSettings`, `instanceBackups`.

- [ ] **Step 1: Write the failing static test.** Assert: no `BEGIN`; `SET LOCAL lock_timeout`; both `CREATE TABLE`; the enums; `INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING`.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement** the migration and the schema.
- [ ] **Step 4: Run** the test and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(db): instance settings and backup history`.

### Task 4: Backup core and `opsdeck backup run`

**Files:**
- Create:
  - `lib/instance-backup/manifest.ts`
  - `lib/instance-backup/retention.ts`
  - `lib/instance-backup/destination.ts`
  - `lib/instance-backup/archive.ts`
  - `scripts/cli/backup.ts`
- Modify: `Dockerfile` (runner gets `postgresql-client-18` from the PGDG apt repo, matching server major 18)
- Test:
  - `tests/instance-backup-manifest.test.ts`
  - `tests/instance-backup-retention.test.ts`
  - `tests/instance-backup-run.test.ts`

**Interfaces:**
- Produces:
  - `type BackupManifest = { format: 1; version: string; createdAt: string; database: { file: "dss_panel.dump" | string; sha256: string; bytes: number }; garage: { objects: number; bytes: number }; secretsKeyFingerprint: string }`. The database file is `database.dump`.
  - `secretsKeyFingerprint(key: string): string`, the first 16 hex characters of the sha256.
  - `selectForDeletion(keys: { key: string; createdAt: Date }[], keepDaily: number, keepWeekly: number): string[]`. Keep the newest per day for `keepDaily` days, then the newest per ISO week for `keepWeekly` weeks. Delete the rest.
  - `runInstanceBackup(trigger: "schedule" | "manual" | "update"): Promise<{ id: string; status: "succeeded" | "failed"; location: "s3" | "local"; objectKey: string | null; errorCode: string | null }>`.
  - CLI: `opsdeck backup run [--trigger update]` prints one JSON line with the result, and exits non-zero on failure.

**Archive layout:**
- Object key `opsdeck-backups/<instance>/<YYYY-MM-DDTHHmmssZ>-<version>/`.
- Files: `database.dump` (`pg_dump -Fc` of `DATABASE_URL`), `garage/<key>` objects copied from the in-network Garage (`S3_ENDPOINT`), and `manifest.json` written last.
- Local fallback: `/var/lib/opsdeck/backups/<same>/` (bind mount `${dir}/backups`), with retention 3 by count.

- [ ] **Step 1: Write the failing tests.**
  - The manifest round-trips.
  - The fingerprint of `"abc"` is the first 16 hex characters of its sha256.
  - Retention: given 40 daily keys, `(14, 8)` keeps 14 dailies plus up to 8 weekly representatives and returns the rest.
  - `upload failure keeps local copy`: the destination `PutObject` rejects → status `failed`, `errorCode: "backupUploadFailed"`, the local dir still has the files, and the row is `failed`.
  - `no destination writes local`: `location: "local"`, retention 3 is applied.
  - `never writes SECRETS_KEY`: no written file contains the key value.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `pg_dump` runs via `Bun.spawn` and streams to a temp file; compute its sha256 while streaming.
  - Garage is copied object by object with `@aws-sdk/client-s3`.
  - The destination client is built from the `s3_connections` row (decrypted `secretKey`).
  - Retention is applied after a successful upload.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(backup): opsdeck backup run to an S3 connection or local`.

### Task 5: Backups UI, schedule and attention

**Files:**
- Create:
  - `server/services/instance-backups.ts`
  - `server/routes/instance.ts`
  - `web/routes/$locale/_app/admin.instance.tsx`
  - `web/routes/$locale/_app/-components/admin/instance/backups-tab.tsx`
  - `web/api/instance.ts`
- Modify:
  - `lib/permissions.ts` (org statement `instance: ["manage"]`, admin only)
  - `lib/queue.ts` (a job scheduler `instance-backup` using the existing `upsertJobScheduler` pattern, cron from `backup_time` and `APP_TIMEZONE`)
  - `lib/jobs/processor.ts`
  - `components/app-sidebar.tsx` (Admin → Instance)
  - `server/services/home.ts` (attention item for a failed, unacknowledged backup, or none in 36 h)
  - messages
- Test: `tests/instance-backups-api.test.ts`, `tests/admin-instance-backups.test.tsx`

**Interfaces:**
- Consumes: `runInstanceBackup` and `secretsKeyFingerprint` (Task 4).
- Produces:
  - `GET /api/instance/backups` → `{ settings, backups: InstanceBackup[] }`;
  - `PUT /api/instance/backups/settings` with `{ destinationId: string | null, time: "HH:MM", keepDaily: 1..90, keepWeekly: 0..52 }`;
  - `POST /api/instance/backups/run`;
  - `POST /api/instance/backups/:id/acknowledge`;
  - `POST /api/instance/backups/verify-key` with `{ key }` → `{ match: boolean }`. It compares fingerprints and never stores or logs the key.
  - All gated by `instance:manage`.

- [ ] **Step 1: Write the failing tests.**
  - A non-admin gets 403 with code `forbidden`.
  - Changing settings re-registers the scheduler with the new cron.
  - `run` enqueues a job.
  - `verify-key` returns `match: false` for a wrong key, and its response body never echoes the key.
  - Home shows the attention item when the latest backup failed.
  - The page renders the destination select, time, retention, the history table and the "not offsite" warning when the destination is null.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Store `secrets_key_fingerprint` at boot when null.
  - The page warns, in all 5 locales, that a restore needs `SECRETS_KEY` and that it is not in the backup.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(backup): admin instance backups page, schedule and attention`.

### Task 6: Host updater (`update.sh`, units) — update and restore

**Files:**
- Create:
  - `ops/install/update.sh`
  - `ops/install/opsdeck-updater@.path`
  - `ops/install/opsdeck-updater@.service`
  - `lib/updates/request.ts` (schemas shared with the app)
  - `tests/updater/update-sh.test.ts`
- Test harness:
  - The test runs `update.sh` with `PATH` stubs for `docker` and `curl` (fake scripts that record their argv and return scripted output) in a temp dir.
  - It also runs `shellcheck -s sh` via `bunx` or a container when available, and skips with a notice when not.

**Interfaces:**
- **Request file `${dir}/updates/request.json`:**
  - `{ "action": "update", "version": "1.2.3" }` or `{ "action": "restore", "objectKey": "<key>", "version": "<manifest version>" }`;
  - plus `requestedBy` and `requestedAt`.
  - `lib/updates/request.ts` exports the zod schemas `updateRequestSchema` and `updateStatusSchema`.
- **Status file `${dir}/updates/status.json`:**
  - `{ runId, action, version, from, step: "validate"|"backup"|"pull"|"migrate"|"up"|"health"|"rollback"|"done", state: "running"|"succeeded"|"failed"|"rolled_back"|"refused", code: string|null, startedAt, finishedAt|null, logTail: string[] }`;
  - plus a per-run log `${dir}/updates/logs/<runId>.log`.
- **Units:**
  - `opsdeck-updater@.path` uses `PathChanged=/opt/%i/updates/request.json`, where the instance name is the dir basename;
  - `.service` is `Type=oneshot` with `ExecStart=/usr/local/lib/opsdeck/update.sh /opt/%i`.
- **`update.sh <dir>` algorithm:**
  1. Take a lock with `flock` on `${dir}/updates/.lock`. If it is already running, exit without touching the status.
  2. Read the request. The version must match `^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$`, else `refused` with code `invalidRequest`.
  3. Download `release.json` for `v<version>` from the GitHub Release (`https://github.com/romikusumabakti/opsdeck/releases/download/v<version>/release.json`) and check:
     - the running `OPSDECK_VERSION` (from `.env`) is at least `minFrom`, else `refused` with `belowMinFrom`;
     - the target is not older than the running version, else `refused` with `downgrade`. Restore is exempt from this check.
  4. Back up: `docker compose run --rm app opsdeck backup run --trigger update`. A failure gives `failed` with `backupFailed`, and nothing else changes.
  5. Record the current `.env` image lines into `${dir}/updates/previous.env`.
  6. Write the new digests from `release.json` into `.env`, then `docker compose pull`.
  7. `docker compose run --rm migrate`.
  8. `docker compose up -d --wait --wait-timeout 180`.
  9. Health: `curl` through Caddy with the instance `Host` header. The body's version must equal the target.
  10. A failure in any of steps 6–9 restores `previous.env` and runs `up -d --wait`, giving `rolled_back` with code `<step>Failed`.
- **Restore** (`action: "restore"`):
  - validate the version as above;
  - pin that version's digests;
  - `docker compose stop app terminal`;
  - `docker compose run --rm app opsdeck restore <objectKey>` (Task 7 CLI);
  - `up -d --wait`, then health;
  - then, when the current release is newer, continue as an update to it;
  - a backup newer than the newest reachable release is `refused` with `backupTooNew`.

- [ ] **Step 1: Write the failing tests.**
  - `rejects non-version request`: `"1.2.3; rm -rf /"` and `"../x"` are refused, and no docker call is made.
  - `rejects below minFrom`.
  - `rejects downgrade`.
  - `backup failure aborts update`: no pull or up after a failed backup.
  - `rolls back when health fails`: `.env` equals `previous.env`, status `rolled_back`, code `healthFailed`.
  - `succeeds`: the call order is backup, pull, migrate, up, health, and status is `succeeded`.
  - `status survives app restart`: the status is written by the script and only read by the app.
  - `restore pins manifest version`, then updates to the newer one.
  - `refuses newer backup`.
  - `lock prevents a second run`.
  - `shellcheck clean`.
- [ ] **Step 2: Run** `env -u SECRETS_KEY bun --bun vitest run tests/updater`. Expected: FAIL.
- [ ] **Step 3: Implement** `update.sh` (POSIX sh, `set -eu`, no bash-isms) and the units.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ops): host updater with backup, rollback and restore`.

### Task 7: Restore CLI and the app side of updates

**Files:**
- Create:
  - `scripts/cli/restore.ts`
  - `lib/updates/releases.ts`
  - `web/routes/$locale/_app/-components/admin/instance/updates-tab.tsx`
- Modify:
  - `server/routes/instance.ts`, `server/services/instance-backups.ts` (restore request)
  - `lib/queue.ts` (hourly `instance-update-check`)
  - `admin.instance.tsx`
  - messages
- Test: `tests/cli-restore.test.ts`, `tests/updates-releases.test.ts`, `tests/instance-updates-api.test.ts`

**Interfaces:**
- Consumes: `updateRequestSchema` and `updateStatusSchema` (Task 6), `compareVersions` and `channelOf` (Task 1).
- Produces:
  - `opsdeck restore <objectKey>`:
    - downloads the archive from the configured destination, or reads it from the local dir when the key starts with `local:`;
    - verifies the manifest sha256 (`restoreChecksumMismatch` on failure);
    - checks the `SECRETS_KEY` fingerprint matches (`restoreKeyMismatch`, which refuses);
    - `pg_restore --clean --if-exists --no-owner -d $DATABASE_URL`;
    - restores the Garage objects.
  - `latestRelease(channel: "stable" | "beta", current: string): Promise<{ version: string; notesUrl: string; minFrom: string } | null>`. It reads `https://api.github.com/repos/romikusumabakti/opsdeck/releases`. On `stable` it ignores prereleases; on `beta` it takes the newest of all. It returns null when nothing is newer than `current`.
  - API (all `instance:manage`):
    - `GET /api/instance/updates` → `{ current, channel, autoUpdate, available, status }`, where status is the parsed `status.json` or null;
    - `PUT /api/instance/updates/settings` with `{ channel, autoUpdate, window }`;
    - `POST /api/instance/updates/apply` with `{ version }`, which writes `request.json` atomically (temp file plus rename);
    - `POST /api/instance/backups/:id/restore` with `{ confirm: "<instance name>" }`, which writes a restore request.
  - The auto-update job writes the apply request inside the window when `available` is set.

- [ ] **Step 1: Write the failing tests.**
  - `latestRelease` with fixture JSON:
    - stable skips `1.3.0-beta.1` and returns `1.2.1`;
    - beta returns `1.3.0-beta.1`;
    - null when current is the newest.
  - `apply` writes an exact request JSON, and refuses a version that is not `available` (`updateNotAvailable`).
  - `restore` refuses a wrong confirmation (`confirmMismatch`).
  - `opsdeck restore` refuses on a checksum mismatch and on a key-fingerprint mismatch, and calls `pg_restore` with the exact flags on success.
  - The Updates tab shows current/available, the Update button, live step progress from status, and the rolled-back message.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** The status file is read from the `/var/lib/opsdeck/updates` mount. A missing mount shows the "updater not installed" state, with code `updaterMissing`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(updates): release check, update and restore requests, restore CLI`.

### Task 8: Product compose, `install.sh` (install, adopt, restore) and the release workflow

**Files:**
- Create:
  - `ops/install/compose.yaml`
  - `ops/install/env.example`
  - `ops/install/install.sh`
  - `.github/workflows/release.yml`
  - `scripts/release-manifest.ts`
  - `tests/install/install-sh.test.ts`
  - `tests/release-manifest.test.ts`
- Keep: the repo-root `compose.yaml` (development; builds from source).

**Interfaces:**
- **`ops/install/compose.yaml`:**
  - Services `postgres`, `valkey`, `garage`, `imgproxy`, `caddy`, `migrate`, `app`, `terminal`.
  - Images come only from `.env` digests. No `build:` and no `container_name:`; names come from `COMPOSE_PROJECT_NAME`.
  - Postgres has no host port.
  - `app` depends on `migrate` (`service_completed_successfully`).
  - Bind mounts: `${OPSDECK_DIR}/updates:/var/lib/opsdeck/updates` (the app gets it read-write so it can write `request.json`) and `${OPSDECK_DIR}/backups:/var/lib/opsdeck/backups`.
  - Caddy publishes `127.0.0.1:${OPSDECK_HTTP_PORT:-8080}:80`.
  - Volume names are `${COMPOSE_PROJECT_NAME}_postgres` and so on. In adopt mode they are overridden by `OPSDECK_VOLUME_*` to the existing names.
- **`install.sh` flags:**
  - `--version vX.Y.Z` (default: the latest stable from the GitHub API);
  - `--channel stable|beta`;
  - `--dir /opt/opsdeck`;
  - `--hostname <host>` (sets `BETTER_AUTH_URL=https://<host>`);
  - `--http-port N`;
  - `--adopt <old .env path>`;
  - `--restore <objectKey or local path>`;
  - `--dry-run` (prints every action and runs nothing).
- **What `install.sh` does:**
  - Installs Docker from Docker's apt repo when it is missing.
  - Generates secrets with `openssl rand -base64 32`, except in adopt mode, which copies `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `SECRETS_KEY`, the Microsoft and Resend keys, `BRAND` and the S3 keys from the old `.env`.
  - Writes `.env` 0600.
  - Installs `update.sh` to `/usr/local/lib/opsdeck/` and enables `opsdeck-updater@<basename>.path`.
  - Runs `docker compose up -d --wait`.
  - Adopt mode runs `opsdeck migrate --adopt` before `up`.
  - Prints the URL and the `SECRETS_KEY` save reminder (never the key).
  - Refuses an existing `.env` unless adopt mode is set.
- **`release.yml`**, on push of tags `v*`:
  - lint, typecheck, test;
  - `docker/setup-buildx-action` and `docker/build-push-action` for `linux/amd64,linux/arm64`, with `build-args: OPSDECK_VERSION`;
  - push `ghcr.io/romikusumabakti/opsdeck:<version>` plus the channel tag;
  - `actions/attest-build-provenance` for the digest;
  - `bun scripts/release-manifest.ts` writes `release.json` = `{ version, minFrom, images: { app: "<ref>@sha256:…", postgres, valkey, garage, imgproxy, caddy }, notesUrl }`;
  - `softprops/action-gh-release` with `prerelease: true` for beta tags, uploading `release.json`, `install.sh`, `update.sh`, `compose.yaml`, `env.example` and the unit files.
  - `minFrom` comes from `release/min-from.txt` in the repo (initially `0.1.0`).

- [ ] **Step 1: Write the failing tests.**
  - `release-manifest` builds the exact JSON from inputs and rejects a non-digest ref.
  - `install.sh --dry-run --dir <tmp>` prints, in order: docker check, dir create, `.env` write (0600), unit install, compose up.
  - The adopt dry-run copies the named keys and never prints their values.
  - It refuses an existing `.env` without adopt.
  - The compose config is valid: `docker compose -f ops/install/compose.yaml --env-file ops/install/env.example config` exits 0 when docker is available, and is skipped with a notice otherwise.
  - shellcheck is clean.
  - `actionlint` passes on `release.yml` when available.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ops): installer, product compose and release workflow`.

### Task 9: `opsdeck seed demo`

**Files:**
- Create: `scripts/cli/seed.ts`, `tests/cli-seed.test.ts`

**Interfaces:**
- Produces `opsdeck seed demo`. It creates, or keeps if present (keyed by fixed keys):
  - projects `DEMO` "Demo Membership" and `DEMOPORTAL` "Demo Portal", each with environments `Dev` and `QA`;
  - placeholder servers `sandbox-1.invalid` and `sandbox-2.invalid`, with placement `open`, a dummy encrypted password and no reachable host;
  - a few issues in mixed statuses.
- Accounts `demo-admin`, `demo-infra`, `demo-observer`, `demo-engineer`, `demo-qa`, `demo-viewer`, each `@example.invalid`, with email+password sign-in:
  - org roles admin, infra, observer, member, member, member;
  - project memberships engineer, qa, viewer on both projects.
- It prints one line per account created, with a generated password (`--print-passwords`). Existing accounts are listed without a password and are never reset.
- It refuses when `NODE_ENV=production` and the instance channel is `stable`, unless `--force`.

- [ ] **Step 1: Write the failing tests.**
  - `seed is idempotent`: running twice gives the same row counts, and the second run prints no passwords.
  - Roles and memberships are exactly as above.
  - It refuses on a stable channel.
  - No server row has a reachable host (all end in `.invalid`).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use better-auth's server API (`auth.api.signUpEmail` or the admin `createUser`) so password hashing matches sign-in.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat: opsdeck seed demo for beta instances`.

---

## Rollout (controller with Romi; each production step needs Romi's go-ahead)

1. **Merge and push. Tag `v0.2.0-beta.1`.** Check the GitHub Release assets, the attestation and the GHCR image.
2. **Move SonarQube's database:**
   - Romi approves the SonarQube downtime.
   - Back up `sonarqube_db`, restore it into `shared-postgres`, and give it a loopback port or the SonarQube network as found in `/opt/sonarqube`.
   - Repoint the JDBC URL, then verify the SonarQube UI and analysis.
   - Install the SonarQube-only backup timer to 55.111.
3. **Install beta on .113:**
   - Run `install.sh --channel beta --dir /opt/opsdeck-beta --hostname panel-beta.dssconsulting.id --http-port 8081`.
   - In the prod Panel, create a project "Opsdeck" with environment "Beta" and a tunnel domain `panel-beta` → port 8081, DSS Internal.
   - Create the first admin on `/setup`, then run `opsdeck seed demo --print-passwords`.
   - Save the passwords to `~/.config/secrets/dss/opsdeck-beta-accounts` (0600).
4. **Backups to R2:**
   - Romi creates the R2 bucket `opsdeck-backups` and an R2 API token scoped to it, then enters it in Panel → Storage as an S3 connection. The token is pasted in the UI only.
   - Set the destination on beta first, then on prod after the adopt.
5. **Role check:** Romi signs in as each demo account on beta.
6. **Tag `v0.2.0` stable after beta passes. Adopt production:**
   - Take a backup.
   - Run `install.sh --version v0.2.0 --dir /opt/opsdeck --hostname panel.dssconsulting.id --adopt /deployments/dss-panel/.env --http-port 80`, with the existing volume names.
   - Verify health and version.
   - Romi disables the Jenkins job `DSS/dss-panel`.
7. **Retire the old timer:**
   - After 7 days of successful prod backups and one restore drill of a prod backup into beta (with beta's own `SECRETS_KEY` swapped temporarily, or a dedicated scratch instance), disable `dss-panel-backup.timer`.
   - Update the memory files `opsdeck-prod-deploy.md`, `dss-panel-no-routine-backup.md` and `db-migrations.md` (procedure retired).
