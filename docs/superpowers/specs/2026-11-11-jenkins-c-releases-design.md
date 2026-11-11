# Retire Jenkins, part C: releases, artifact download, Jenkins off — design

Status: approved decisions from Romi (2026-11-11); builder-checked. Project 4 of the Panel program, part C of three (A container apps — done; B legacy artifact deploys — done and rolled out on 9 hosts → **C**). Part B design: `2026-11-10-jenkins-b-legacy-artifacts-design.md`.

## Why

After part B, Jenkins on .113 still runs 18 `RELEASE-*` / `UAT-*` jobs and `DPLK/common-main-membership`. The release jobs exist so the legacy team has a jar or `dist` to upload to a client's FTP (TMLI, DPSIU, CAR). Today the team takes that file from three places, and each person does it differently:

- the Jenkins job's archived artifact;
- a build on their own laptop;
- a copy from a test VM.

So nobody can say which build a client is running. Several of those jobs do not even archive their artifact.

Jenkins itself costs about 1.9 GB of RAM on a host whose disk is 77% full, and it is one more public endpoint (`jenkins.aktuariku.id`).

Part C gives releases one source, the Panel, then switches Jenkins off.

## Decisions made with Romi (2026-11-11)

1. **One source for client releases.** A release is the exact artifact a Panel deploy already ran on one of that client's test environments (build once, deploy many). There are no separate release builds.
2. **Who may mark a release:** any engineer of the project, but only from a build that deployed successfully to an environment of that project.
3. **What a release records:**
   - entered by the person: a version name (required, free text, e.g. `TMLI 2026-11-2`) and release notes (optional);
   - recorded by the Panel: who and when, and the source build (component, branch, commit, tag);
   - also recorded: the environment and deployment it was tested on.
   - FTP delivery stays manual, and the Panel does not track it.
4. **Kept forever.** Registry tags are pruned weekly (`ci-disk-maintenance` keeps the 10 newest tags per branch), so the release artifact is copied to permanent storage when the release is made.
5. **Download = one file per release:** the jar as is, or the `dist` folder as one `.zip`. The file name carries the version.
6. **Only engineers** of the project may download. QA cannot.
7. **Scope: legacy artifact components only** (`jar` and `static` kinds). Container apps are not delivered by FTP.
8. **Jenkins:**
   - stopped;
   - `/var/lib/jenkins` (job configs, build history, encrypted credentials) archived to the backup host 192.168.55.111;
   - then uninstalled.
9. **Bitbucket: two tokens from Romi**, both in `~/.config/secrets/dss/` (0600):
   - **a temporary token** (webhooks read/write on the workspace's repositories) to remove the Jenkins webhooks, revoked after part C;
   - **a permanent token** limited to writing the `dplk-k8s` repository. It is stored as a Woodpecker repo secret on `dplk-membership` for the manifest push `common-main-membership` does today.
10. **Any build that deployed successfully** to an environment of the project may become a release, including feature branches. This also replaces the `UAT-*` hand-off builds. The source branch is shown clearly in the dialog and the Releases list, and the version name is free (e.g. `UAT 2026-11 risk profile`).
11. **Releases are per component.** Backend and frontend are marked separately and may share a version name. The Releases list groups rows with the same version name.
12. **Old Jenkins artifacts are not imported.** They stay inside the `/var/lib/jenkins` archive on 55.111.

## The release feature

- **Where:**
  - On an environment's Deploys page, each successful deployment of a `jar` or `static` target offers **Mark as release**. The dialog asks for the version name and notes.
  - The project gets a **Releases** list: version, component, source build, tested-on environment, who/when, size, and **Download** (engineers only).
- **What happens on Mark as release:**
  1. The Panel reads the artifact layer of `<componentKey>-deploy:<tag>` from the registry (part B's `openArtifactLayer`).
  2. It extracts the artifact: the single jar, or the `dist` tree zipped (`yazl` is already a dependency).
  3. It stores the result once in the Panel's own S3 storage (Garage) under a key that never changes.
  4. It records the release row, including the file's size and sha256.

  This can take a while for a 130 MB jar, so it runs as a job (like deploys and backups) and the release shows "preparing" until the file is stored. If the registry no longer has the tag, the release fails with a clear message.
- **Rules:**
  - The version name is unique per project and component (two releases of `legacy-core-backend` in TMLI cannot both be `TMLI 2026-11-2`).
  - Releases cannot be edited after creation, apart from the notes.
  - Deleting a release is an admin-only action that also deletes the stored file *(Claude's call, so "forever" stays the default but a mistaken release can be removed)*.
- **Download:**
  - The Panel streams the file through its own API, because Garage is not published and the engineer-only check must hold. There is no presigned URL.
  - The response sets `Content-Disposition` with a file name like `legacy-core-backend_TMLI-2026-11-2.jar` *(exact format is the builder's call)*.
- **Audit:** creating, downloading and deleting a release go into `activity_log`.
- **Storage note:** Garage lives on .113's disk. "Forever" is safe from registry pruning, but not from a disk loss on .113, until the offsite backup destination (R2, a separate open item) exists. The Releases page states the total size so disk growth stays visible. Instance backups skip the Garage prefix `releases/` (controller ruling, 2026-11-11), and a restore leaves the bucket's release files in place.

## Turning Jenkins off

Order, each step with Romi's go-ahead:

1. **`DPLK/common-main-membership` → Woodpecker.** The builder reads the job (GET only) and reproduces it on `dplk-membership` `main`:
   - the image build;
   - the image-tag update in `dplk-k8s`, branch `DTN-Core-Common`, which is still used by ArgoCD on the k3s cluster.

   The second part is a Woodpecker step that uses the permanent `dplk-k8s` token (decision 9) as a repo secret. The job is then disabled.
2. **Disable all `RELEASE-*` and `UAT-*` jobs** once the release feature is on prod. The legacy team is told that releases now come from the Panel.
3. **Remove the Jenkins webhooks** from every Bitbucket repository that has one. The match is the hook URL `https://jenkins.aktuariku.id/bitbucket-hook/`. Woodpecker's own hooks stay.
4. **Archive and switch off:**
   - stop `jenkins`;
   - write `/var/lib/jenkins` as one `.tar.zst` to 55.111 next to the HRIS backups, and verify it (list + checksum);
   - disable and uninstall the package.
5. **Clean up around it:**
   - remove the public hostname `jenkins.aktuariku.id` (tunnel `dss-srv-113` route + DNS) and its Cloudflare Access apps;
   - drop the Jenkins-workspace part of `ci-disk-maintenance` (the registry pruning stays);
   - update the memory notes and the runbooks that still mention Jenkins.

## Non-goals

- Tracking FTP delivery or client acknowledgement.
- Releases for container apps.
- Building release artifacts separately from test deploys.
- Moving storage offsite (R2) — a separate item.

## For the builder

- **Cloudflare for `jenkins.aktuariku.id`** is reachable with stored credentials:
  - DNS of `aktuariku.id`: the certbot token on 192.168.55.245;
  - Access apps: the laptop Access token;
  - the `dss-srv-113` tunnel route: the Panel's account token.
- **Left to the builder:**
  - the release table shape;
  - the job that copies the artifact;
  - tar extraction (a small parser, or a dependency if justified);
  - the streaming download route;
  - the UI placement within the existing Deploys and project pages;
  - the exact download file name.
- **Constraints carried from part B:**
  - Docker media types for images;
  - secrets never in output;
  - every server-side change needs Romi's go-ahead.
