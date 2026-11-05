import { z } from "zod";
import {
  bundleImageSchema,
  composeServiceSchema,
  deployDirSchema,
  deployRegistrySchema,
  deployTagSchema,
  envVarNameSchema,
  HEALTH_TIMEOUT_MAX_SECONDS,
} from "@/lib/deploy/validation";
import { shq } from "@/lib/sh";

/**
 * Builds the one POSIX `sh` script a deploy runs on a Docker Compose host over
 * SSH. Pure: no SSH, no database. It is the part that decides what executes on
 * a client's server, so it validates its whole input and quotes every
 * interpolated value with `shq` — except `preStartCommand`, which is
 * maintainer-entered target config and is inserted verbatim by design.
 *
 * Invariants the tests hold it to: it never runs `compose down/stop/rm`, it
 * only (re)starts the listed services (`--no-deps`), the only `.env` line it
 * touches is the tag variable — unless `installStagedEnvFile`, when it first
 * replaces `.env` with the staged `.env.opsdeck-new` the Panel uploaded — and
 * a stack that never turns (and stays) healthy makes it exit non-zero within
 * `healthTimeoutSeconds`.
 */

export interface DeployScriptInput {
  registry: string;
  bundleImage: string;
  tag: string;
  deployDir: string;
  services: string[];
  tagVariable: string;
  preStartCommand: string | null;
  healthUrl: string | null;
  healthTimeoutSeconds: number;
  /**
   * How long every service must stay OK, over consecutive polls, before the
   * deploy counts as healthy. Guards against a container without a
   * healthcheck that is `running` right after `up -d` and crashes seconds
   * later. Defaults to {@link DEFAULT_STABLE_SECONDS}.
   */
  stableSeconds?: number;
  /**
   * The environment's `.env` is managed by the Panel: the job has uploaded the
   * rendered file as `.env.opsdeck-new`. Right after taking the lock, the
   * script keeps the current `.env` as `.env.opsdeck-prev` and moves the
   * staged file into place (both `0600`), or exits non-zero before any pull
   * with the previous `.env` untouched. Off by default; when off, the script
   * is exactly what it was before this option existed.
   */
  installStagedEnvFile?: boolean;
}

export const DEFAULT_STABLE_SECONDS = 30;

const HEALTH_POLL_SECONDS = 5;

// How long a deploy waits for an earlier script on the same deploy dir.
const LOCK_WAIT_SECONDS = 600;

// Per container: restart count, start time, status, health (empty when the
// image has no healthcheck).
const INSPECT_FORMAT =
  "{{.RestartCount}} {{.State.StartedAt}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}";

const deployScriptInputSchema = z.object({
  registry: deployRegistrySchema,
  bundleImage: bundleImageSchema,
  tag: deployTagSchema,
  deployDir: deployDirSchema,
  services: z.array(composeServiceSchema).min(1),
  tagVariable: envVarNameSchema,
  preStartCommand: z.string().nullable(),
  healthUrl: z.url({ protocol: /^https?$/ }).nullable(),
  healthTimeoutSeconds: z.number().int().min(1).max(HEALTH_TIMEOUT_MAX_SECONDS),
  stableSeconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(DEFAULT_STABLE_SECONDS),
  installStagedEnvFile: z.boolean().default(false),
});

/** Throws a ZodError when any field of the input is invalid. */
export function buildDeployScript(input: DeployScriptInput): string {
  const v = deployScriptInputSchema.parse(input);
  const image = shq(`${v.registry}/${v.bundleImage}:${v.tag}`);
  const services = v.services.map(shq).join(" ");
  const envLine = `${v.tagVariable}=${v.tag}`;
  // Tag and variable name are regex-restricted, so neither can carry the `|`
  // delimiter, `&`, `\` or a newline into the sed expression.
  const sedExpr = `s|^${v.tagVariable}=.*|${envLine}|`;
  const preStart = v.preStartCommand?.trim() ? v.preStartCommand : null;

  const lines = [
    "set -eu",
    // Keep going if the Panel's SSH session drops (timeout, Panel restart):
    // dying between removing an old container and starting its replacement
    // would leave the service down.
    "trap '' HUP PIPE",
    `cd ${shq(v.deployDir)}`,
    // One deploy at a time per deploy dir, even when an orphaned script from a
    // dropped session is still running.
    "exec 9>.opsdeck-deploy.lock",
    `flock -w ${LOCK_WAIT_SECONDS} 9 || { echo 'DEPLOY LOCKED'; exit 1; }`,

    // 0. Managed .env: keep the current file once, then rename the staged one
    //    over it (atomic, same directory). Any failure stops here, before any
    //    pull, with the previous .env still in place.
    ...(v.installStagedEnvFile
      ? [
          `if [ -f .env ]; then cp -p .env .env.opsdeck-prev && chmod 600 .env.opsdeck-prev || { echo 'ENV INSTALL FAILED'; exit 1; }; fi`,
          `chmod 600 .env.opsdeck-new && mv -f .env.opsdeck-new .env || { echo 'ENV INSTALL FAILED'; exit 1; }`,
        ]
      : []),

    // 1. Deploy bundle: compose.yaml and friends, extracted into the deploy dir.
    `docker pull ${image}`,
    `cid=$(docker create ${image} noop)`,
    // Remove the bundle container on the failure path too, then still fail.
    `docker cp "$cid":/bundle/. . || { docker rm "$cid" >/dev/null || true; exit 1; }`,
    `docker rm "$cid" >/dev/null`,

    // 2. The tag variable — the only .env line the Panel ever changes.
    `if [ -f .env ] && grep -q ${shq(`^${v.tagVariable}=`)} .env; then`,
    `  sed -i ${shq(sedExpr)} .env`,
    "else",
    // Keep the previous last line intact when .env lacks a trailing newline.
    `  if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi`,
    `  printf '%s\\n' ${shq(envLine)} >> .env`,
    "fi",

    // 3. Images, then the optional pre-start hook, then only the listed services.
    `docker compose pull ${services}`,
    // Subshell: an `exit` or `cd` in the hook cannot end or redirect the rest
    // of the script, and the blank line absorbs a trailing backslash. A
    // non-zero status still aborts under `set -e`.
    ...(preStart === null ? [] : ["(", preStart, "", ")"]),
    `docker compose up -d --no-deps ${services}`,

    // 4. Health. A poll is OK when every container of every listed service
    //    is running with health `healthy` or no healthcheck, its RestartCount
    //    and StartedAt equal the previous poll's (a crash loop under a restart
    //    policy still reads `running` in `compose ps`; only these move), and
    //    the health URL answers if one is set. The first poll is therefore a
    //    baseline. HEALTHY needs consecutive OK polls spanning stableSeconds;
    //    any non-OK poll resets the window.
    `deadline=$(( $(date +%s) + ${v.healthTimeoutSeconds} ))`,
    "ok_since=",
    "prev_snap=",
    "while :; do",
    "  ok=1",
    "  snap=",
    `  for svc in ${services}; do`,
    `    ids=$(docker compose ps -q "$svc") || ok=0`,
    `    if [ -z "$ids" ]; then ok=0; fi`,
    "    for id in $ids; do",
    `      info=$(docker inspect -f ${shq(INSPECT_FORMAT)} "$id") || { ok=0; continue; }`,
    `      snap="$snap $id $(printf '%s\n' "$info" | awk '{ print $1, $2 }')"`,
    `      printf '%s\n' "$info" | awk '{ exit !($3 == "running" && ($4 == "" || $4 == "healthy")) }' || ok=0`,
    "    done",
    "  done",
    `  if [ "$snap" != "$prev_snap" ]; then ok=0; fi`,
    "  prev_snap=$snap",
    ...(v.healthUrl === null
      ? []
      : [
          `  if [ "$ok" = 1 ]; then curl -fsS -o /dev/null --max-time 5 ${shq(v.healthUrl)} || ok=0; fi`,
        ]),
    "  now=$(date +%s)",
    `  if [ "$ok" = 1 ]; then`,
    `    if [ -z "$ok_since" ]; then ok_since=$now; fi`,
    `    if [ $(( now - ok_since )) -ge ${v.stableSeconds} ]; then echo 'HEALTHY'; exit 0; fi`,
    "  else",
    "    ok_since=",
    "  fi",
    `  if [ "$now" -ge "$deadline" ]; then echo 'HEALTH TIMEOUT'; exit 1; fi`,
    "  left=$(( deadline - now ))",
    `  sleep $(( left < ${HEALTH_POLL_SECONDS} ? left : ${HEALTH_POLL_SECONDS} ))`,
    "done",
  ];
  return `${lines.join("\n")}\n`;
}
