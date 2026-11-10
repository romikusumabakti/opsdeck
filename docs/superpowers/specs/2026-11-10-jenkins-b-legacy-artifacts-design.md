# Retire Jenkins, part B: legacy artifact deploys — design

Status: draft for Romi's review (2026-11-10). Project 4 of the Panel program, part B of three (A container apps — done → **B legacy artifact deploys** → C releases + Jenkins switched off).
Recon (read-only, 2026-11-10): `docs/superpowers/specs/recon-2026-11-10-project-4b.md` (scratch, not committed). Part A design: `2026-11-09-jenkins-a-container-apps-design.md`.

## Why

The legacy apps (core, backoffice, customer portal "bakunawa", accounting) are still built and deployed by 42 Jenkins freestyle jobs. Every `SERVER_*` job builds on push and copies a jar or a `dist` folder to a client test VM over SSH, then restarts a systemd unit or nginx. They have no backup, no health check, and no rollback. Branches are edited by hand in Jenkins to whatever feature branch is under test. Five of the jobs are broken today. Part B moves these deploys to Woodpecker (build) and the Panel (deploy), so the legacy team picks a branch and deploys in the same place as everyone else.

## Decisions made with Romi

From the project 4 brainstorm (2026-11-09):
1. **No containers for legacy apps.** Clients run the jar on a host, so test environments must match. Woodpecker builds the jar / `dist` once; the Panel deploys that same artifact to the VM the way Jenkins does. (Dev/prod parity, build once deploy many.)
2. **Any engineer in the project picks the branch and deploys.** The legacy team edits Jenkins job branches today.
3. **Client UAT/production delivery stays manual** (the legacy team uploads to the client's FTP). Marking a build as a release and offering the artifact download is **part C**, not B.

From the part B session (2026-11-10):
4. **Broken jobs are fixed during migration.** The Woodpecker pipeline uses the right toolchain and branch, so those targets work again.
5. **Dead hosts and dormant jobs are not migrated.** Hosts .117 and .124 are unreachable, and five jobs are older than 90 days. A target can be added later from the UI.
6. **Deploy improvements, all four:**
   - keep the previous version for rollback;
   - health-check after the restart;
   - `nginx -t` plus reload instead of restart;
   - enable a unit that is not enabled.
7. **The backoffice OAuth `client_secret` baked into the frontend bundle is out of scope.** It is a legacy application design issue, recorded separately.
8. **The Panel commits the pipeline file to the branch.** When an engineer picks a branch for a legacy target, the Panel commits `.woodpecker.yaml` to that branch (existing "generated pipeline" mode), and that commit triggers the build. The legacy team's branches get one bot commit `ci: …`.
9. **Artifacts live in the registry** as a `FROM scratch` image, like today's deploy bundle. The Panel fetches the layer from the registry and streams it to the VM over SSH. Part C may copy releases to S3 later.

## Scope

**In.** The `SERVER_*` deploy jobs on reachable hosts become Panel deploy targets:

| Client | Host | Targets (component → what) | Jenkins jobs replaced |
|---|---|---|---|
| CAR | 55.127 | core jar (`core`), backoffice static | SERVER_127 BE/FE |
| CAR | 55.129 | core jar, backoffice static | SERVER_129 BE/FE (FE broken today) |
| CAR | 55.137 | core jar, backoffice static | SERVER_137 BE/FE |
| COMMON-DEMO | 55.119 | core jar, backoffice static | SERVER_119 BE/FE (FE broken; `core.service` failed today) |
| DPSIU | 55.114 | accounting jar (`accounting`), accounting static | SERVER_114 BE/FE |
| DPSIU | 55.115 | core jar, backoffice static | SERVER_115 BE/FE |
| TMLI | 55.121 | core jar, backoffice static | SERVER_121 BE/FE |
| TMLI | 55.122 | core jar, backoffice static, portal jar (`portal`), portal static | SERVER_122 ×4 (portal FE branch wrong today) |
| TMLI | 55.123 | portal jar, portal static | SERVER_123 BE/FE |

That is 20 targets on 9 hosts. Branches start as the Jenkins job's current branch (recon table), corrected where it is broken (TMLI .122 portal FE: `release-tmli`, not `release/tmli`).

**Out.**
- `RELEASE-*` and `UAT-*` jobs: they produce artifacts for manual client delivery. They move in **part C**, and keep running until then.
- Hosts .117 and .124, and their four `SERVER_*` jobs (decision 5).
- Client production systems: the Panel never deploys to a client's servers.

## How a legacy deploy works

### Build (Woodpecker)

- **One Panel component per legacy repository**, in generated pipeline mode:

  | Repository | Component | Build |
  |---|---|---|
  | `id.dssconsulting.core` | core backend | Gradle 4.8.1 wrapper on JDK 8 (`./gradlew build -x test`) → `build/libs/dss-service-0.1.0.jar` |
  | `backoffice` | core frontend | Node + pnpm + Grunt (`pnpm install`, `pnpm release`; Grunt picks the client target from the branch default) → `dist/` |
  | `id.dssconsulting.bakunawa` | portal backend | Gradle 4.8.1 on JDK 8 → `build/libs/bakunawa-0.1.0.jar` |
  | `customer-portal` | portal frontend (legacy) | vue-cli `npm run build` → `dist/` |
  | `accounting_dss_backend_2021_geek` | accounting backend | Maven on JDK 11 → `target/acc-backend-api-0.0.1-SNAPSHOT.jar` |
  | `accounting_dss_frontend_2021_geek` | accounting frontend | vue-cli with `NODE_OPTIONS=--openssl-legacy-provider` → `dist/` |

- The build runs in a pinned toolchain image per component (JDK 8, JDK 11, the Node version each frontend actually builds with). Choosing and verifying those images is the builder's job; the recon lists what Jenkins used.
- The generated pipeline pushes one image, `${componentKey}-deploy:${TAG}`, `FROM scratch`. It holds the artifact under `/bundle/artifact/`: the jar file for a jar component, the contents of `dist/` for a static component. It uses Docker media types and no provenance attestation, as every DSS pipeline does now. Tags stay `origin-<branch>-<sha>`. The notify step is the same as today.
- **`customer-portal` is already a container component** (`dplk-customer-portal-frontend`, custom pipeline on `portal-common-dapenmu` and `sucor/*`). Its legacy TMLI branches need a second component on the same repository. Today `app_components` allows one component per CI repo. The builder must lift that limit, or find another way for one repository to feed two components. The hook already names the component in `app`. *(Open point for the builder.)*

### Branch selection

- An engineer of the project sets or changes a legacy target's source branch in the Panel (decision 2).
- If the component's pipeline file is not on that branch yet, the Panel commits it (existing `commitPipelineFiles` flow and per-branch `pipeline_file_commits` record). That commit is a push, so Woodpecker builds it at once. The target is flagged "deploy next build" (existing `deployNextBuild`) when it has no auto-deploy, so the engineer's choice ends in a deploy without a second click.
- The generated legacy pipeline builds on every push of a branch that carries the file. Branches cut from such a branch build too. *(Claude's call: no branch filter, so a feature branch made from a release branch works without another commit; the registry already has a garbage-collect job.)*

### Deploy target kinds

A deploy target gets a **kind**: `compose` (today's targets, the default), `jar`, or `static`.

- **`jar`**:
  - deploy dir: the jar's directory, e.g. `/deployments/core-web-service`;
  - jar file name: e.g. `core-web-service.jar` (Jenkins renames the built jar);
  - systemd unit: `core`, `portal` or `accounting`;
  - optional health URL; health timeout.
- **`static`**:
  - web root: e.g. `/deployments/web`, `/deployments/customer-portal/web`, `/deployments/accounting/web`;
  - no unit, because nginx is reloaded.
- Compose-only fields (services, tag variable, pre-start command, managed `.env`, compose overlay, backup before deploy) do not apply to `jar` and `static`. The form shows only what applies.

### The deploy

The worker:
1. reads the artifact layer from the registry (the Panel needs registry read credentials, a new setting);
2. streams it over SSH into a staging directory next to the target, on the same filesystem;
3. runs one script.

The server needs no Docker. The script:

- **Common:**
  - `set -eu`, the HUP trap, and `flock` on a lock file in the deploy dir, as the compose script does.
  - The staging directory is removed on every exit.
- **`jar`:**
  1. The staged jar must exist and be non-empty.
  2. If the unit is not enabled, `systemctl enable <unit>`, with a line in the output (decision 6).
  3. `systemctl stop <unit>`.
  4. The current jar is moved to `<deploy dir>/.opsdeck-prev/<jar name>` (replacing the older copy), and the staged jar is moved into place.
  5. `systemctl start <unit>`.
  6. **Health:** the unit is `active` and its `MainPID` stays the same for 30 s. If a health URL is set, it must also answer an HTTP status below 500 within the health timeout.
- **`static`:**
  1. The staged `dist` must contain `index.html`.
  2. Owner, mode and SELinux context of the new tree are copied from the current web root (`chown -R --reference`, and `chcon -R --reference` when SELinux is enabled). Otherwise nginx can answer 403 after the swap.
  3. Swap: the current root goes to `<web root>.opsdeck-prev` (replacing the older copy), and the new tree goes into place.
  4. `nginx -t`, then `systemctl reload nginx`. If `nginx -t` fails, the swap is undone and the deploy fails.
- **No automatic revert on a failed health check** *(Claude's call)*. The deploy fails, and the engineer uses **Rollback**, which redeploys the previous successful tag (existing behaviour). The `.opsdeck-prev` copy is the manual safety net when the registry no longer has a tag.
- The Panel records deploy times from its own clock. Several of these hosts have shifted clocks on purpose (mock-date testing).

### Where the targets live in the Panel

An environment deploys exactly one app (`environments.app_id`). So the six components belong to three new apps, one per legacy system *(Claude's call: `legacy-core`, `legacy-portal`, `legacy-accounting`)*:

| App | Components |
|---|---|
| `legacy-core` | core backend, backoffice |
| `legacy-portal` | portal backend (bakunawa), portal frontend (legacy) |
| `legacy-accounting` | accounting backend, accounting frontend |

The legacy environments already exist in the Panel, one per host and app, all with no app and no targets (production `dss_panel`, 2026-11-10). Each target goes into the environment below, and that environment takes the app of its first target.

| Host | Project → environment | App |
|---|---|---|
| 55.114 | DPMB → Accounting DPSIU | `legacy-accounting` (its registered services say `core`; fix to `accounting` during rollout) |
| 55.115 | DPMB → Membership DPSIU | `legacy-core` |
| 55.119 | TMMB → Dev Frontend | `legacy-core` (Jenkins files it under COMMON-DEMO) |
| 55.121 | TMMB → Dev | `legacy-core` |
| 55.122 | TMMB → Release | `legacy-core` |
| 55.122 | TMPT → Release | `legacy-portal` |
| 55.123 | TMPT → Dev | `legacy-portal` |
| 55.127 | CRMB → Release | `legacy-core` |
| 55.129 | CRMB → Fee Daily | `legacy-core` |
| 55.137 | CRMB → P2SK | `legacy-core` |

**Teardown:**
- Deleting an environment with `jar` or `static` targets removes the Panel records only and leaves the server untouched *(Claude's call)*. These are long-lived client test VMs, and stopping `core` or wiping `/deployments/web` is never what "delete environment" should mean there.
- Provisioning does not apply to these kinds.

## Rollout

Per host, in the order of the scope table *(order is Claude's call, the same as the part A cutovers)*:
1. With Romi's approval, the host's `SERVER_*` jobs are disabled. This has to come first. The Panel's pipeline commit is a push to the branch those jobs watch, and two deploys must never race on one host: Jenkins `rm`+`cp` against the Panel's `mv` to `.opsdeck-prev`.
2. The target is created, and the component's pipeline is generated and committed to the target branch.
3. The Woodpecker build passes, and the target deploys it ("deploy next build").
4. Romi or the legacy team checks the app.
5. Auto-deploy is turned on where the Jenkins job deployed on push.

Prerequisites, checked first:
- The Panel reaches each host by SSH key as root. .114 rejected the laptop key in recon; the Panel key must be verified there.
- `portal.service` on .122 is not enabled; the first deploy enables it.
- `core.service` on .119 is failed today; the first deploy shows whether a working build fixes it.

## Out of scope / later

- Part C: releases, artifact download, the `RELEASE-*` and `UAT-*` jobs, the Bitbucket webhooks, and Jenkins switched off.
- NTP and the shifted host clocks (intentional for testing).
- Host identity clean-up: .137 reports the hostname `rocky-129`, and three hosts are `localhost.localdomain`.

## For the builder

- **Open:** two components from one CI repository (`customer-portal`).
- **Open:** which Node image builds each frontend (backoffice needs `pnpm install`; Node 24 broke `npm run release` without an install; accounting needs the legacy OpenSSL provider).
- **Open:** registry read credentials for the Panel, and how they are stored. Follow the existing encrypted-settings pattern.
- **Left to the builder:**
  - the exact columns for kind, jar name and unit;
  - the registry blob fetch (manifest → single layer);
  - the SSH streaming upload helper (none exists; `executeRemoteCommand` buffers);
  - the form changes.
