# Panel Prerequisites and Deploy Release Implementation Plan (plan B of the CI/deploy spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **[controller, needs Romi's go-ahead]** touch production and are run by the controller, not an implementer subagent, only after Romi confirms in the chat.

**Goal:** Make the Panel safe to hold deploy power, then release plan A. That means: Cloudflare Access in front of `panel.dssconsulting.id`, routine off-host backups, server credentials encrypted at rest, and ops scripts runnable in the production image.

**Architecture:**
- **Code (opsdeck repo):**
  - A pure planner plus a CLI that encrypts legacy plaintext secret columns.
  - Ops scripts bundled into `dist/` so `docker exec opsdeck-app` can run them.
  - A versioned backup script and systemd units under `ops/backup/`.
- **Operations:**
  - Install the backup timer on .113, pushing to node 55.111 through a restricted `rrsync` key.
  - Create the Access apps through the Cloudflare API.
  - Apply plan A's migrations, then deploy the Panel through the existing Jenkins job `DSS/dss-panel`.

**Tech Stack:** Bun, TypeScript, Vitest; bash + systemd on Rocky 9 (.113); Docker; rsync/rrsync on Proxmox 55.111; Cloudflare Access API.

**Spec:** `docs/superpowers/specs/2026-11-03-ci-build-deploy-design.md`, section "Prerequisites before the Panel deploys anything". Plan A, already merged: `docs/superpowers/plans/2026-11-03-panel-deploy.md`.

## Global Constraints

- **Language:** English for code, scripts, units, logs and docs.
- **Secrets:**
  - Never print a secret (SECRETS_KEY, DB passwords, S3 keys, decrypted column values) to stdout, logs or files outside the intended 0600 files.
  - Scripts report counts only.
- **Encrypted format:** `enc:v1:` via `encryptSecret`/`isEncrypted` from `lib/secrets.ts`. A value already encrypted is never re-encrypted. Empty and null values stay as they are.
- **Columns to encrypt:** `servers.password`, `environment_services.db_password`, `environment_services.mock_time_api_key`, `s3_connections.secret_key`.
  - Not `jira_connections.webhook_secret`: it is a URL token compared in plaintext by design.
  - Not `accounts.access_token`: better-auth owns it; that is out of scope.
- **Backups:**
  - Run daily at 02:30 local time (Asia/Jakarta).
  - `pg_dump -Fc` of `dss_panel` and `sonarqube_db`, plus `pg_dumpall --globals-only`, all from container `opsdeck-postgres`.
  - The Garage bucket `knowledge` is mirrored with rclone over the compose network.
  - Local retention on .113 is 14 days in `/var/backups/dss-panel/`, with files 0600 and the directory 0700.
  - Each night the off-host copy goes to `root@192.168.55.111:/var/backups/dss-panel-113/` with `rsync`. It uses a dedicated ed25519 key whose `authorized_keys` entry is `restrict,command="rrsync -wo -no-del /var/backups/dss-panel-113"`. Off-host retention is 30 days, pruned on the receiver by a daily cron or timer on 55.111.
  - Any failure exits non-zero, so `systemctl --failed` shows it.
- **Cloudflare Access** (account `26d7f3d7145a68c255226b6399805357`; token at `~/.config/secrets/dss/cloudflare-access-token`):
  - App `dss-panel` on host `panel.dssconsulting.id`, reusable policy `DSS Internal` (`640a51e7-8c26-48bb-9a2a-5df671e19126`), IdP Entra `1bc8806d-34a1-477f-9989-63cf4b59f201`, `auto_redirect_to_identity: true`.
  - Two bypass apps using the reusable `Atlassian Bitbucket Bypass` policy (`1e04eab0-97a5-40d1-ac62-2aaecfb71960`): `panel.dssconsulting.id/api/jira/webhook` and `panel.dssconsulting.id/api/deploy-hooks`.
  - All 13 Panel users are `@dssconsulting.id` (checked 2026-11-04), so nobody is locked out.
- **Production rules:**
  - Migrations follow the opsdeck memory `db-migrations.md` procedure: pg_dump, then a `ROLLBACK` dry run, then apply, then record.
  - A Jenkins build is a deploy, so it is triggered only after Romi's go-ahead.
  - Config changes go only in `/deployments/dss-panel/.env`, never in the Jenkins workspace.

## Review Focus

1. **A secret column holding an empty string, NULL, an already-encrypted value, or a plaintext value that happens to start with `enc:`.** Only true plaintext is encrypted. Empty and NULL stay. A value is encrypted at most once. Test: Task 1.
2. **The encrypt script run twice, or interrupted halfway.** The second run reports 0 to change. A partial run leaves every row either fully plaintext or fully encrypted, never corrupted. Each row is updated with an `UPDATE … WHERE id = $1 AND <col> = <old value>` guard. Test: Task 1.
3. **The backup run while 55.111 is unreachable, or while `opsdeck-postgres` is down.** The local dump still lands if Postgres is up, the unit fails visibly, and no partial file keeps a final name (write to `*.partial`, then rename). Test: Task 3 (shell test with stubs).
4. **The restricted key used for anything other than writing into the backup directory** (shell, reading outside the directory, `rsync --delete` of other paths). This must be refused by `restrict` + `rrsync`. Verification: Task 4.
5. **External callers after Access is enabled.**
   - Jira's webhook and Woodpecker's notify must still reach the app: an unsigned POST gets the app's own 401/404, not a 302 to `cloudflareaccess.com`.
   - A browser without an Access session gets the 302.

   Verification: Task 5.

---

### Task 1: Encrypt legacy plaintext secrets (planner + CLI)

**Files:**
- Create: `lib/secrets-migration.ts`
- Create: `scripts/encrypt-legacy-secrets.ts`
- Test: `tests/secrets-migration.test.ts`

**Interfaces — Produces:**
- `SECRET_COLUMNS: readonly { table: "servers" | "environment_services" | "s3_connections"; column: string }[]`, holding exactly the four columns from Global Constraints.
- `planEncryption(rows: { id: string; value: string | null }[]): { id: string; from: string; to: string }[]`. It skips null, `""` and `isEncrypted(value)`, and sets `to = encryptSecret(from)`.
- CLI: `bun dist/encrypt-legacy-secrets.js [--apply]`. The default is a dry run. For each column it prints `<table>.<column>: <encrypted>/<plaintext> (would change N | changed N)`. Each update uses `UPDATE <table> SET <col> = $to WHERE id = $id AND <col> = $from`. Rows whose guard misses are counted as `skipped (changed concurrently)`. The CLI exits non-zero if `SECRETS_KEY` is missing.

- [ ] **Step 1: Write failing tests in `tests/secrets-migration.test.ts`** (`SECRETS_KEY` set in the test):
  - `planEncryption skips null, empty and already-encrypted values`
  - `planEncryption encrypts plaintext and the result decrypts back` (uses `decryptSecret`)
  - `a plaintext value starting with "enc:" but not a valid enc:v1 payload is encrypted` (matches `isEncrypted` semantics; assert whatever `isEncrypted` returns drives the decision)
  - `running the plan on its own output yields no changes` (idempotence)
  - `SECRET_COLUMNS lists exactly the four columns`
- [ ] **Step 2: Run** `bun --bun vitest run tests/secrets-migration.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the planner and the CLI. The CLI uses `db` from `lib/db` with raw `sql` for the dynamic table/column names, picking only from `SECRET_COLUMNS`. It never prints values.
- [ ] **Step 4: Run** the test, `bun run typecheck` and `bun run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): encrypt legacy plaintext secret columns`.

### Task 2: Ship ops scripts in the production image

**Files:**
- Modify: `package.json`. In the `build` script, add `bun build scripts/deploy-app.ts scripts/encrypt-legacy-secrets.ts --target=bun --conditions react-server --define process.env.NODE_ENV=process.env.NODE_ENV --outdir dist --entry-naming [name].[ext]`.
- Modify: `docs/deploy.md` (the "register an app" section uses `docker exec opsdeck-app bun dist/deploy-app.js …`)
- Test: `tests/build-ops-scripts.test.ts`

**Interfaces — Produces:** `dist/deploy-app.js` and `dist/encrypt-legacy-secrets.js` in the runner image. The Dockerfile already copies `dist/`.

- [ ] **Step 1: Write the failing test.** It runs the package's ops-script build command (factor it into its own npm script, `build:ops`, called from `build`) into a temp outdir with `spawnSync`. It asserts that both `.js` files exist and that `bun <file> --help` exits 0 without needing a DB. Both CLIs must print usage on `--help` before touching the DB or the key.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** `build:ops`, add `--help` handling to both scripts, and update `docs/deploy.md`.
- [ ] **Step 4: Run** the test, then `bun run build` and `ls dist/*.js`. Expected: PASS, and both files are present.
- [ ] **Step 5: Commit** `build(ops): bundle deploy-app and encrypt-legacy-secrets into dist`.

### Task 3: Backup script and systemd units (repo)

**Files:**
- Create: `ops/backup/dss-panel-backup.sh`
- Create: `ops/backup/dss-panel-backup.service`
- Create: `ops/backup/dss-panel-backup.timer`
- Create: `ops/backup/prune-received.sh` (for 55.111)
- Create: `ops/backup/README.md`
- Test: `tests/ops-backup.test.ts`

**Interfaces — Produces:**
- **`dss-panel-backup.sh`** (bash, `set -euo pipefail`, run as root). Configuration is env with defaults:
  - `BACKUP_DIR=/var/backups/dss-panel`
  - `PG_CONTAINER=opsdeck-postgres`
  - `DATABASES="dss_panel sonarqube_db"`
  - `COMPOSE_NETWORK=dss-panel_default`
  - `ENV_FILE=/deployments/dss-panel/.env`
  - `REMOTE=root@192.168.55.111:`
  - `SSH_KEY=/root/.ssh/dss-panel-backup`
  - `RETENTION_DAYS=14`

  What it does:
  1. Creates `$BACKUP_DIR/<YYYY-MM-DD>/` with mode 0700.
  2. Writes `<db>.dump` per database via `docker exec … pg_dump -U postgres -Fc`, and `globals.sql` via `pg_dumpall --globals-only`. Each file is written to `*.partial`, then `mv`d to its final name.
  3. Mirrors Garage with `docker run --rm --network $COMPOSE_NETWORK rclone/rclone:1 sync :s3:knowledge /data/garage`. The S3 settings come from `S3_*` in `$ENV_FILE`; they are passed as `RCLONE_CONFIG_*` env and never on the command line.
  4. Writes `SHA256SUMS`.
  5. Runs `rsync -a --partial -e "ssh -i $SSH_KEY -o BatchMode=yes" "$BACKUP_DIR/<date>/" "$REMOTE<date>/"`.
  6. Deletes local date directories older than `RETENTION_DAYS`.
  7. Logs one summary line with byte counts.

  The exit code is non-zero if any step fails, but the remote push is attempted only after the local dumps succeed.
- **The units:**
  - The `.service` is Type=oneshot with `ExecStart=/usr/local/sbin/dss-panel-backup.sh`.
  - The `.timer` uses `OnCalendar=*-*-* 02:30:00 Asia/Jakarta` and `Persistent=true`.
- **`prune-received.sh`** deletes `/var/backups/dss-panel-113/<date>` directories older than 30 days.
- **README:** install steps (Task 4) and the restore procedure (`pg_restore -d` into a scratch container, rclone copy back).

- [ ] **Step 1: Write failing tests in `tests/ops-backup.test.ts`.** Run the script with `spawnSync("bash", …)` and stub `docker`, `rsync` and `ssh` on `PATH`, writing to temp dirs. Required tests:
  - `happy path writes both dumps, globals, garage dir and SHA256SUMS, then rsyncs` (the stub log order is pg_dump, then rclone, then rsync)
  - `postgres failure exits non-zero, leaves no final-named dump and does not rsync` (Review Focus 3)
  - `rsync failure exits non-zero but keeps the local dumps` (Review Focus 3)
  - `retention removes only date dirs older than RETENTION_DAYS`
  - `S3 secret never appears in the stub argv log`
- [ ] **Step 2: Run** `bun --bun vitest run tests/ops-backup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script, the units, the prune script and the README. If `shellcheck` is available (`bunx shellcheck` or brew), the script must pass it.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): daily Panel backup with off-host copy`.

### Task 4: Install backups on .113 and 55.111 [controller, needs Romi's go-ahead]

- [ ] On .113, generate `ssh-keygen -t ed25519 -N '' -f /root/.ssh/dss-panel-backup -C dss-panel-backup@113`.
- [ ] On 55.111 (root over password SSH, credentials at `~/.config/secrets/dss/proxmox-root-password`):
  - Run `mkdir -p -m 0700 /var/backups/dss-panel-113`.
  - Append `restrict,command="rrsync -wo -no-del /var/backups/dss-panel-113" <pubkey>` to `/root/.ssh/authorized_keys`, after backing the file up to `authorized_keys.bak-2026-11-04`.
  - Install `prune-received.sh` and a daily timer for it.
- [ ] **Off-host SECRETS_KEY copy** (the key is not in the backup and `dss_panel` is unrestorable without it): on the laptop, `ssh root@<.113> 'grep ^SECRETS_KEY= /deployments/dss-panel/.env' | cut -d= -f2- > ~/.config/secrets/dss/dss-panel-secrets-key; chmod 600 ~/.config/secrets/dss/dss-panel-secrets-key`. Never print it or store it beside the dumps.
- [ ] On .113, install the script to `/usr/local/sbin/` (0700) and the units to `/etc/systemd/system/`, run `systemctl daemon-reload`, then `systemctl enable --now dss-panel-backup.timer`.
- [ ] Run once with `systemctl start dss-panel-backup.service`. Check `journalctl -u dss-panel-backup -n 20`, and that the files exist on both hosts with matching SHA256SUMS.
- [ ] **Restore test:** in a throwaway `postgres:18` container on .113, `pg_restore` `dss_panel.dump` and compare row counts of `users`, `environments` and `runs` with live. Remove the container afterwards.
- [ ] **Restricted-key check (Review Focus 4):** the following must all fail:
  - `ssh -i key root@192.168.55.111 id`
  - `rsync … root@192.168.55.111:/etc/`
  - an rsync read from the backup directory (`root@192.168.55.111: /tmp/x/`)
  - `rsync -r --delete` of an empty directory into it
  - writing outside the directory

  A write into it must succeed.
- [ ] Update the opsdeck memory: replace `dss-panel-no-routine-backup.md` with the new state.

### Task 5: Cloudflare Access in front of the Panel [controller, needs Romi's go-ahead]

- [ ] Before creating anything, confirm the external callers:
  - grep the code for public routes (`tests/authz-guards.test.ts` `PUBLIC`);
  - check that only Jira and Woodpecker call in from outside;
  - check that no uptime monitor uses `/api/health` (ask Romi if unknown).
- [ ] Create the two bypass apps first (`/api/jira/webhook`, `/api/deploy-hooks`), then the host app `dss-panel`, following the Global Constraints (POST `/accounts/<acc>/access/apps`).
- [ ] **Verify (Review Focus 5):**
  - `curl -sI https://panel.dssconsulting.id/` → 302 to `dssconsulting.cloudflareaccess.com`
  - `curl -s -X POST -H 'Content-Type: application/json' https://panel.dssconsulting.id/api/deploy-hooks/builds -d '{}'` → the app's 401 or 503 JSON, not HTML
  - `curl -s -X POST https://panel.dssconsulting.id/api/jira/webhook/x -H 'Content-Type: application/json' -d '{}'` → the app's own response, not 302
  - Romi signs in through the browser: Access with Entra, then the Panel login. The Microsoft sign-in callback must still work.
- [ ] Update the opsdeck memory `opsdeck-panel-cloudflare-tunnel.md` (the "Access still missing" gap is now closed) and the DSS memory `cloudflare.md` (the Access apps list).

### Task 6: Release plan A and encrypt secrets [controller, needs Romi's go-ahead]

- [ ] Push opsdeck `main` (18+ commits ahead of origin), after confirming with Romi.
- [ ] Apply migrations `20261104000000_run_kind_deploy`, then `20261104000100_deploy_tables`, by the `db-migrations.md` procedure, and add the rows to that memory's table.
- [ ] Set `DEPLOY_REGISTRY=192.168.56.113:5000` in `/deployments/dss-panel/.env`, after backing up the file to `.env.bak-2026-11-04`.
- [ ] After Romi's go-ahead, trigger the Jenkins job `DSS/dss-panel`. Then check:
  - `curl -s -H 'Host: panel.dssconsulting.id' http://localhost:80/api/health` on .113
  - the boot log has no "Panel deploys disabled" warning
- [ ] Run `docker exec opsdeck-app bun dist/encrypt-legacy-secrets.js` (dry run) and show Romi the counts. Then run it with `--apply`. Re-run the dry run: every column should report 0 plaintext.
- [ ] Spot-check that decryption still works end to end: open a Panel service log (SSH using `servers.password`) and a DB backup list in the UI.
- [ ] Browser check of the Deploys page (the open item from plan A): it renders, a contributor account sees no action buttons, and the add-target form validates. No live deploy yet; plan C does the first one.
- [ ] Update the opsdeck memories `panel-deploy-feature.md` (released), `dss-panel-plaintext-secrets.md` (encrypted; old dumps still sensitive) and `db-migrations.md`.
