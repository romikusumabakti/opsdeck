# Opsdeck self-install, self-update and self-backup — design

Status: draft for Romi's review (2026-11-09). This is project 2 of 4 in the Panel program. Project 1 (simplification) went live on 2026-11-09. Next come (3) SSH keys for servers and (4) the Jenkins → Panel + Woodpecker migration. Removing the DSS-specific parts so opsdeck works for anyone is a separate project after this one.

## Why

- Opsdeck (the DSS Panel) still depends on Jenkins. The job `DSS/dss-panel` runs `docker compose up -d --build` inside Jenkins' own workspace on .113. Migrations are applied by hand over SSH, and there is no install path for a new server.
- Romi wants opsdeck to be a **product others can install** on their own server, in the style of Dokploy and Coolify: one install command, in-app updates, and backups the panel manages itself.
- Romi has never seen the Panel as another role. A separate **beta instance** on .113 with sample data and test accounts fixes that, and it doubles as the place where new releases are tried first.
- The current backup is a systemd timer that copies to 55.111. It is invisible in the Panel and lives outside the product.

Prior art (researched 2026-11-09):
- **Dokploy:** the app holds `docker.sock` and runs `docker service update` on Swarm. Migrations run in the container CMD. There is no automatic rollback.
- **Coolify:** checks `versions.json` hourly. Before an update it backs up its DB, then runs `upgrade.sh` on the host over SSH using a helper container. Rollback is manual.
- **Watchtower** was archived in 2025-12 and does nothing for migrations, backup or rollback.

## Decisions made with Romi (2026-11-09)

1. The goal is a **product for others**. Removing the DSS specifics is a separate later project.
2. **Panel self-backup goes to an S3 connection, offsite on Cloudflare R2.** The Panel schedules it, shows history and restores from the UI. The old timer to 55.111 is switched off once the new backup has proven itself.
3. **Beta instance on .113:**
   - its own database, holding sample data and one test account per role;
   - hostname **`panel-beta.dssconsulting.id`** behind Cloudflare Access *(Claude's call, approved as the recommendation)*.
4. **"The most ideal, canonical, future-proof" choice, delegated to Claude:**
   - **The updater is a host systemd unit.** The app never holds `docker.sock`.
   - **Releases use semver tags with stable and beta channels.** GitHub Actions builds the images to GHCR with build provenance attestations and creates a GitHub Release. Updates are manual by default, with optional auto-update.

## Install

The command is `curl -fsSL https://<release host>/install.sh | sh`, which serves `install.sh` from the latest GitHub Release. It also runs as `sh install.sh --version vX.Y.Z --channel beta --dir /opt/opsdeck-beta --hostname …`.

- **Supported hosts:** any Linux with systemd on amd64 or arm64 (Debian, Ubuntu, Rocky/RHEL, ...) whose Docker Engine runs with Compose v2 2.23.1 or later. Only on Debian/Ubuntu does the script install Docker itself; on another distribution without Docker, or with an older Compose, it stops and points to Docker's install docs for that distribution. It refuses SELinux in enforcing mode (the bind mounts are not relabelled) and anything else unsupported, with a clear message.
- **What the script does, in order:**
  1. Install Docker Engine and Compose v2 if absent, via Docker's official apt repository (Debian/Ubuntu only; elsewhere Docker must already be installed).
  2. Create the install dir, `/opt/opsdeck` by default; one dir per instance.
  3. Write `compose.yaml` from the release assets.
  4. Write `.env` (0600) with generated `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `SECRETS_KEY` and the Garage keys. Images are pinned by digest, e.g. `OPSDECK_IMAGE=ghcr.io/romikusumabakti/opsdeck:1.2.0@sha256:…`.
  5. Install the updater units (below).
  6. `docker compose up -d --wait`.
  7. Print the URL and tell the user to save `SECRETS_KEY` offline.
- **Re-runnable:** an existing install dir is never overwritten, so the script works for repair and for the upgrade to a new compose layout.
- **Several instances per host:** each gets its own compose project name, ports and dir. That is how prod and beta share .113.
- **Setup page:** the first admin is created on the existing `/setup` page.
- **Install config:** the images (app, terminal) and the non-app images (postgres, valkey, caddy, garage, imgproxy) are all pinned. The compose file no longer builds from source, and `container_name`s come from the compose project, not hard-coded.

## Releases

- **Tags:**
  - `vX.Y.Z` is **stable** and `vX.Y.Z-beta.N` is **beta**.
  - The version comes from the tag and is baked into the image (`OPSDECK_VERSION`). `/api/health` reports it.
- **GitHub Actions on a tag:**
  - run lint, typecheck and tests;
  - build multi-arch images (amd64, arm64) and push them to GHCR as `X.Y.Z`, plus `beta` or `stable` channel tags;
  - attach a build provenance attestation;
  - create the GitHub Release with `install.sh`, `compose.yaml`, `.env.example` and a `release.json` listing the image digests, the minimum version it can update from, and the notes link. Beta tags are marked as prereleases.
- **Update check:** the Panel polls GitHub Releases once an hour, for the instance's channel only. Admins see "Version X available" with the notes. A beta instance also sees stable releases that are newer.
- **Auto-update:** a per-instance setting, off by default. When on, it applies updates in a chosen window.

## Update

The app writes a request and a host unit performs the update.

- **Request:**
  - The admin presses **Update** (permission: `integration:manage` or a new `instance:manage` — builder's choice; admin only).
  - The app writes `{version, requestedBy, requestedAt}` to `/<dir>/updates/request.json`, a host dir bind-mounted read-write into the app.
  - The app never runs Docker.
- **`opsdeck-updater@<instance>.path` + `.service` (root):**
  - The path unit watches the request file.
  - The service runs a fixed script shipped with the release, the instance's own copy, `/opt/<name>/.updater/update.sh /opt/<name>`.
  - The script reads only the version string and validates it against the GitHub Release (the tag exists, `release.json` digests match, and the running version is at least `minFrom`). Anything else is refused.
- **Steps, each written to `/<dir>/updates/status.json`** (which the UI polls):
  1. Back up the DB with the same code path as scheduled backups, to the configured destination. A backup failure aborts the update.
  2. Record the current image digests.
  3. `docker compose pull`.
  4. Run migrations as a one-shot `migrate` service; the app has `depends_on: service_completed_successfully`.
  5. `docker compose up -d --wait --wait-timeout 180`.
  6. Health-check `/api/health` through Caddy and expect the new version.
  7. **On failure after the pull:** put the old digests back and run `up -d --wait` again. Status becomes `rolled_back` with the log tail.
- **The update run outlives the app container,** because it is a host service. The UI shows the steps and the result once the new app is up.
- **Migrations:**
  - Drizzle's migrator, `migrate()` from drizzle-orm with the folder format in `drizzle/`, runs in the `migrate` service.
  - The 53 existing hand-applied migrations are **squashed into one baseline migration**. 38 of them contain their own `BEGIN`/`COMMIT` and cannot run under `migrate()`. *(Claude's call.)*
    - The baseline is generated from the current schema and reproduces the live prod schema, enums and seeded rows.
    - Fresh installs run it.
    - On prod, `drizzle.__drizzle_migrations` is empty today (checked 2026-11-09). Adopt mode records the baseline as applied without running it, after a schema diff of prod against the baseline shows no differences.
  - From now on, migrations follow the migrator's rules: no own `BEGIN`/`COMMIT`; `SET LOCAL lock_timeout`; `ADD VALUE` in its own migration.
  - Migrations must be **expand/contract** so the previous image still runs against the new schema. A contract step (drop or rename) ships at least one release after the code that stopped using it.
  - The hand migration procedure in `db-migrations.md` is retired.

## Self-backup

- **Destination:** an existing **S3 connection** (`s3_connections`) chosen in Admin → Backups. For DSS that is a new Cloudflare R2 bucket, e.g. `opsdeck-backups`.
- **Contents:**
  - `pg_dump -Fc` of the Panel database;
  - a Garage bucket mirror (knowledge attachments);
  - a manifest with version, time, sizes and SHA-256.
  - **`SECRETS_KEY` is never included.** The page warns that a restore needs it and checks a stored fingerprint of the key, so the admin can confirm their offline copy matches.
- **Schedule:** daily at a configurable time (default 02:30 in the instance time zone). Retention by count, e.g. 14 daily plus 8 weekly; old objects are deleted from the bucket.
- **Who runs it:** one command in the app image, `opsdeck backup run`, does the dump, mirror, manifest and upload. It reads the destination from the DB and decrypts the keys with `SECRETS_KEY`. *(Claude's call.)*
  - The scheduled backup runs it from the app worker (BullMQ).
  - The host updater runs the same command as a one-shot container from the app image with the instance `.env`.
  - The app image gains the Postgres client tools.
- **No destination yet** (fresh install, or beta before setup): the backup is written to `/<dir>/backups/` on the host, with retention 3, and the page warns that it is not offsite. An update therefore always has a backup. *(Claude's call.)*
- **History:** each run is recorded as a Panel run, with status, size, duration and errors. A failure shows in Home's "Needs attention".
- **Restore:**
  - From Admin → Backups, choose a backup and press **Restore**. This is destructive and needs a typed confirmation.
  - It hands off to the host updater with a restore request: stop the app, `pg_restore --clean` into a fresh database, start the app, health-check.
  - It also works from the command line: `install.sh --restore <s3 object>` on a fresh install, which is the disaster-recovery path.
  - **Version rule** *(Claude's call)*: a restore runs under the version recorded in the backup manifest.
    - The updater pins that version's images, restores, starts and health-checks.
    - The normal update to the current version follows, which runs any newer migrations.
    - A backup newer than the latest release the instance can reach is refused.
    - `install.sh --restore` installs the manifest's version.
- **DSS cut-over:**
  - Keep the 55.111 timer running until the Panel backup has run successfully for 7 days and one restore drill into the beta instance has passed. Then disable it.
  - **SonarQube moves out first** *(decided with Romi 2026-11-09)*: `sonarqube_db` leaves `opsdeck-postgres` for the existing `shared-postgres` container before the cut-over. Steps: dump/restore, repoint SonarQube's JDBC URL, short downtime. `shared-postgres` has no host port today, so either publish a loopback port (e.g. `127.0.0.1:5433`) or attach SonarQube to the `shared-postgres` network, depending on how SonarQube runs in `/opt/sonarqube`. SonarQube's backup becomes a small timer of its own (SonarQube only) to 55.111. After this, the Panel's Postgres serves only the Panel and needs no host port.

## Beta instance (.113)

- **Installation:** `install.sh --channel beta --dir /opt/opsdeck-beta --hostname panel-beta.dssconsulting.id`, as its own compose project, on its own loopback port behind its own tunnel route plus an Access app (DSS Internal).
- **Cloudflare setup:** the route, DNS record and Access app are created by the production Panel's own domain feature, which holds the Cloudflare account token from plan 3b-2 (Tunnel + Access + DNS). The beta instance is registered in prod as an environment of a project "Opsdeck" with a tunnel domain, and no hand-made DNS is needed. *(Claude's call.)*
- **Seed:** a command in the image (`opsdeck seed demo`) creates:
  - two sample projects whose environments point at sandbox targets only (the panel-canary repos and .113 sandbox ports);
  - test accounts with password login for **admin, infra, observer, member+engineer, member+qa, member+viewer**. Passwords go to `~/.config/secrets/dss/opsdeck-beta-accounts`, never into the repo.
  - It never touches production servers' credentials. The sample servers are **placeholders that cannot be reached** (e.g. `sandbox.invalid`), because the goal is to see each role's view, not to run operations. Romi can add a real sandbox server by hand later. *(Claude's call.)*
- **Use:** every beta tag lands here first, auto-update on. Stable is tagged only after the beta has been checked.

## DSS production cut-over

1. Install the updater units and the new layout at `/opt/opsdeck` with `install.sh --adopt`. Adopt mode:
   - reuses the existing volumes (`postgres_data`, Garage) and the `.env` values from `/deployments/dss-panel/.env`;
   - runs the baseline;
   - switches compose from `--build` to the pinned GHCR image of the first stable release.
2. Verify health, then disable the Jenkins job `DSS/dss-panel` (Romi does this in Jenkins; it is not deleted until the program ends).
3. Leave the old Jenkins workspace untouched for one release, as a fallback.

## Constraints

- **Stack:** Bun/Hono/React app, Drizzle 1.0 rc migrations, BullMQ/Valkey, Docker Compose v2 on the host. The updater is POSIX `sh` plus `docker compose`, with no new runtime on the host.
- **Copy and error codes:** user-facing strings in all 5 locales; error bodies keep a stable `code`.
- **Secrets:**
  - never printed or logged;
  - `.env` is 0600 root;
  - `SECRETS_KEY` is never in a backup;
  - the R2 keys are stored encrypted as an S3 connection.
- **The app container gets no `docker.sock`** and no host root. The only host channel is the request file.
- **Production changes need Romi's go-ahead.** The DSS cut-over follows the backup → dry-run → apply pattern.

## Goals, non-goals, anti-goals

- **Goals:**
  - a fresh systemd Linux server (Docker installed first except on Debian/Ubuntu) runs opsdeck with one command;
  - an admin updates from the UI, with an automatic backup first and automatic rollback of the images on failure;
  - the Panel backs itself up offsite and can restore;
  - Jenkins is no longer involved in deploying the Panel;
  - Romi can sign in as every role on the beta instance.
- **Non-goals:**
  - removing DSS-specific parts (brand, Entra, dssconsulting.id) — a later project;
  - multi-host or HA;
  - Kubernetes or Swarm;
  - automatic database rollback (restore stays a deliberate action);
  - Podman hosts (Docker only for now).
- **Anti-goals:**
  - an update that can leave the Panel down with no way back;
  - a web-facing container with root on its host;
  - backups that silently stop;
  - secrets in backups or releases.

## Left to the builder

- **Engineering details:** exact file layout under the install dir, script structure, and the status-file schema.
- **Permission name:** `instance:manage` or the existing admin-only permission.
- **Notes rendering:** how release notes are shown.
- **Retention edge cases:** how retention picks weeklies.
- **Seed contents:** the exact sample data, within the rules above.
