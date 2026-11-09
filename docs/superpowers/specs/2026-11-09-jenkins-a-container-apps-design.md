# Retire Jenkins, part A: container apps to Woodpecker + Panel, and deleting environments — design

Status: draft for Romi's review (2026-11-09). Project 4 of the Panel program, part A of three (A → B legacy artifact deploys → C releases + Jenkins switched off).
Recon (read-only, 2026-11-09): `docs/superpowers/specs/recon-2026-11-09-project-4a.md` (scratch, not committed).

## Why

Romi wants one simple place for everyone: the Panel. Jenkins hurts on every axis: legacy deploys, CI, duplicate deploys, and the server itself.
- Sucor already moved: Woodpecker builds, the Panel deploys, and all `SUCOR/*` deploy jobs are off.
- The other container apps still build and deploy through Jenkins, several of them twice:
  - two jobs deploy portal backend `main` to the same .136 stack;
  - two branches overwrite the same portal frontend tag on .136;
  - CMS and DMS have twin jobs.
- The Panel cannot delete an environment yet (old plan 5), so dead demo stacks pile up on servers.

## Decisions made with Romi (2026-11-09)

1. **End state of project 4:** Jenkins is switched off completely. This part moves the container apps only.
2. **Keep** `dss-demo-hradmin` (repo `hr-administration`) and `dss-demo-middleware` (`dplk-middleware`).
3. **Retire** `common-main-investment` (repo `dplk-investment-exp3`). Its job is disabled and not moved.
4. **DMS demo:** one environment on **.136** only. .140 is no longer a target.
5. **Deleting an environment** is a full clean with an automatic DB backup first. Engineers may do it.
6. **Order:** this part A first, then B, then C, each with its own spec and plan.
7. **The .136 app tunnel `dss-apps-136` becomes remotely managed** during cutover, so the Panel owns its routes.

## What moves where

Every job below becomes a Woodpecker pipeline on its branch plus a Panel environment with a deploy target. The image tag scheme stays `origin-<branch>-<sha7>`, already used by the Sucor pipelines. *(The project and environment names are Claude's call, following the existing MDMB/MUCP projects.)*

| Jenkins job(s) | Repo / branch | Panel environment → server | Notes |
|---|---|---|---|
| `dss-demo-membership` | dplk-membership / `muhammadiyah/development` | MDMB Demo → .136 `/deployments/dplk-membership` | Ships observability config files today: they stay server-side. Panel deploy restarts only the app services (no `compose down` of Postgres). |
| `dss-demo-portal-backend` + `common-main-portal-backend` (twins) | dplk-customer-portal-backend / `main` | MUCP Demo → .136 `/deployments/dplk-customer-portal` (component backend) | One deploy per push instead of two. Keep the audit + test gates in Woodpecker. `db-migrate` runs as the target's pre-start command, as on Sucor. |
| `dss-demo-portal-frontend` | customer-portal / `portal-common-dapenmu` | MUCP Demo → same dir (component frontend, `FRONTEND_IMAGE_TAG`) | **The plaintext JWT and Turnstile key leave the Jenkinsfile** and become Woodpecker secrets / build vars. |
| `common-main-portal-frontend` | customer-portal / `portal-common` | none (CI build only) *(Claude's call)* | Dormant since May; it pointed at an old production domain and fought the dapenmu branch over the same .136 service. |
| `dss-demo-cms` + `common-main-cms` (twins) | dplk-customer-portal-cms / `dapenmu` | CMS Demo → .132 `/deployments/dplk-customer-portal-cms` | One job for one target. `main` gets CI only *(Claude's call)*. |
| `dss-demo-dms` + `bsi-demo-dms` | dplk-dms / `dapenmu` *(Claude's call: .136 runs the DapenMU tenant)* | DMS Demo → .136 `/deployments/dplk-dms` | Pre-start runs `migrate`; the smoke check becomes the target's health URL. `main` gets CI only. |
| `dss-demo-accounting` | dplk-accounting / `muhammadiyah/development` | Accounting Demo → .136 `/deployments/dplk-accounting` | Its stray push of demo images into the `dplk-k8s` **main** branch is dropped *(Claude's call)*. See the dplk-k8s point below. |
| `dss-demo-investment` | investment / `main` | Investment Demo → .136 `/deployments/dplk-investment` | The demo-only switches (bond price upload, clock simulation, quartz off) move from the Jenkinsfile to the server `.env` on .136. The long readiness window becomes the target's health timeout. |
| `dss-demo-wallboard` | executive-wallboard / `main` | Wallboard Demo → .136 `/deployments/executive-wallboard` | The drizzle migration moves from the Jenkins agent to the target's pre-start command, so the DB URL never leaves the server. |
| `dss-demo-hradmin` | hr-administration / `main` | HR Admin Demo → .136 `/deployments/hr-administration` | Today it is built on the server from a source tarball with no registry. It becomes a normal image build + push like the others; the seed stays in its deploy script. |
| `dss-demo-middleware` | dplk-middleware / `main` | Middleware Demo → .136 `/deployments/dplk-middleware` | Same as hradmin: built on the server today. Its only Jenkins run failed, so the first Panel deploy is effectively its first deploy. Create-DB + migrate + seed go in pre-start. |
| `common-main-membership` | dplk-membership / `main` | none: CI build, then update the image in **`dplk-k8s` branch `DTN-Core-Common`** | **dplk-k8s is live.** On 2026-11-09 the ArgoCD UI at 192.168.56.124:30080 and the k3s API answered, and `democore` is published through Access. A Woodpecker step keeps the manifest push, with a dedicated Bitbucket token stored as a Woodpecker secret. |
| `common-graalvm-membership` | dplk-membership / `sucor/development` | retire *(Claude's call)* | Build-only (its name is not in the deploy map); dormant since July; Woodpecker already builds that branch. |
| `common-main-investment` | dplk-investment-exp3 / `main` | retire (decision 3) | |
| `SUCOR/sucor-cloud-switch` | — | retire *(Claude's call)* | Manual `ssh root@103.54.170.47 sucor-cloud <action>`. Admins run the same command from the Panel terminal on "Server Cloud Sucor", which now logs in by key. No new Panel feature for six commands. |

**Per-job cutover**, one at a time:
1. Add the Woodpecker pipeline on the branch and activate the repo where needed (dms, hr-administration, executive-wallboard, dplk-middleware).
2. Create the Panel environment and target with auto-deploy off.
3. **Register the stack's database** as the environment's DB service, so it can be backed up and deletion knows about it. On .136 this is usually the stack's own Postgres container.
4. **Adopt the hostname** into the Panel (see "Cloudflare on .136" below).
5. Deploy once from the Panel and check health.
6. Turn the target's auto-deploy on.
7. Disable the Jenkins job.

### Cloudflare on .136 (decided with Romi, 2026-11-09)

- **Today:** the demo hostnames live in `dss-apps-136`, a config-file tunnel the Panel cannot manage.
- **Change:** during cutover that tunnel becomes **remotely managed**, so the Panel adds and removes its routes like any other environment's.
- **Same tunnel, no downtime:** it keeps its ID and its container. Only the ingress moves from `config.yml` to the Cloudflare API.
- **Left alone:** the ZITADEL tunnel `dss-zitadel-136` (`demo-auth`, `demo-membership`).
- **Hostname adoption:** each hostname is adopted into the Panel as the environment's domain, together with its existing DNS record and Access app.

The old stacks keep running throughout. Only the image tag changes, so no data moves.

## Deleting an environment

**Who:** org admins, and engineers on their own project's environments (decision 5).

**Steps:** "Delete environment", then a confirm in which the user types the environment name. The Panel then runs one job:
1. **Back up, off the server, before anything is removed** *(Claude's call)*:
   - dump each registered database;
   - make a tar archive of the deploy dir (it holds hand-placed `.env` files and server-only config);
   - copy both to the Panel's backup destination (the instance S3 connection, or Panel-local storage when none is set). The existing per-environment backup writes inside the DB container, which `compose down -v` would destroy.
   - Keep them **30 days**. A daily prune job removes older ones.
   - The backups appear on the Admin → Instance → Backups page under "Deleted environments", with a download link.
2. Stop and remove the stack: `compose down --remove-orphans --volumes` in the deploy dir.
3. Drop the environment's database if the Panel provisioned it on a shared database server.
4. Remove the subdomain: tunnel route, DNS record, Access app.
5. Remove `/deployments/<dir>`, which is already archived in step 1.
6. Delete the Panel rows and record activity.

**Failures:** a step that fails stops the job and leaves the environment in state "deleting failed", with the step and its code shown. Retry continues from the failed step. Nothing is half-deleted silently.

**Refused** (stable codes, before anything runs):
- **Production environments** (`environments.kind = 'prod'`, the flag that already exists) *(Claude's call)*: engineers can't delete them, and admins get an extra confirm.
- **Shared deploy dir:** the dir is also used by another environment's target. Components of the same environment are deleted together, so that case is fine.
- **Unregistered database:** the stack has named volumes but no registered database, so the backup would miss data. Register the database first, or an admin uses "Remove from Panel only".

**"Remove from Panel only"** *(Claude's call)*: today's delete removes only the Panel rows. It stays available, under Advanced options in the same dialog, for admins only. It is meant for stacks the Panel must not touch.
- The existing escrow guard (escrowed variables need an `integration:manage` admin to confirm) applies to both kinds of delete.

## Goals, non-goals, anti-goals

- **Goals:**
  - every in-scope job retired, duplicates gone, one deploy per push;
  - plaintext secrets out of Jenkinsfiles;
  - engineers can delete their own dead environments cleanly.
- **Non-goals (later parts):**
  - legacy freestyle jobs (B);
  - `RELEASE-*`/`UAT-*`, Bitbucket webhook removal and switching Jenkins off (C);
  - DMS on .140;
  - fixing .136's open LAN ports.
- **Anti-goals:**
  - downtime or data loss on the .136 demo stacks during cutover;
  - a deleted environment that leaves its Cloudflare route or database behind;
  - deleting a directory or database that another environment still uses.

## Constraints

- **.136 runs rootful Podman 5.7 behind a `docker` CLI shim.** Panel deploys there must use what works on it (`podman compose` / the shim; see `server-136` memory: Bun hangs, word-split healthchecks, netavark cross-bridge rules).
- **Registry:** `192.168.56.113:5000` stays. Woodpecker builds with rootless BuildKit as today.
- **Migrations:** Drizzle, expand-only, migrator rules (no BEGIN/COMMIT, `SET LOCAL lock_timeout='5s'`).
- **Error contract:** stable codes, with messages in all 5 locales.
- **Product rules:**
  - The Panel is a product, so delete must work on any install, not only DSS.
  - Deletion is simple by default: one confirm. Details appear in the job log, not the dialog.
- **Rollout:** a Jenkins job is disabled only after its Panel target has deployed successfully once. Jenkins API calls stay GET-only except those disables, which Romi approves as part of rollout.

## Left to the builder

- **Pipelines:** the Woodpecker YAML per repo, reusing the Sucor pipelines' shape.
- **Deletion job:** the shape of its state machine and retry.
- **dplk-k8s:** how the manifest update step authenticates (a scoped Bitbucket token).
- **Disabled Jenkins jobs:** whether they are moved to the `Arsip` folder or only disabled.
