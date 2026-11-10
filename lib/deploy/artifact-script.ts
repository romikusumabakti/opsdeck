import { z } from "zod";
import { DEFAULT_STABLE_SECONDS } from "@/lib/deploy/script";
import {
  deployDirSchema,
  HEALTH_TIMEOUT_MAX_SECONDS,
  healthUrlSchema,
  jarNameSchema,
  systemdUnitSchema,
} from "@/lib/deploy/validation";
import { shq } from "@/lib/sh";

/**
 * Builds the POSIX `sh` scripts that deploy a build artifact on a legacy VM
 * (Rocky 8, no Docker) over SSH, as root: a jar run by a systemd unit, or a
 * static web root served by nginx. Pure: no SSH, no database. Every value is
 * validated and every interpolated value quoted with `shq`.
 *
 * The artifact is uploaded first, by a separate SSH command
 * ({@link buildArtifactExtractCommand}), into {@link artifactStagingDir}; the
 * deploy script takes it from `<staging>/bundle/artifact/` and removes the
 * staging dir on exit. A failed health check is never reverted automatically.
 */

export type ArtifactKind = "jar" | "static";

export type ArtifactDeployScriptInput =
  | {
      kind: "jar";
      deployDir: string;
      jarName: string;
      systemdUnit: string;
      healthUrl: string | null;
      healthTimeoutSeconds: number;
      /**
       * How long the unit must stay `active` with the same `MainPID` (and the
       * health URL below 500) over consecutive polls. A crash-looping unit under
       * `Restart=` reads `active` most of the time; only its PID moves.
       * Defaults to {@link DEFAULT_STABLE_SECONDS}.
       */
      stableSeconds?: number;
    }
  | { kind: "static"; deployDir: string; healthTimeoutSeconds: number };

/** Host-wide: every static deploy on a host swaps its root and reloads nginx under it. */
export const NGINX_LOCK_FILE = "/run/opsdeck-nginx.lock";

const HEALTH_POLL_SECONDS = 2;

// How long a deploy waits for an earlier script on the same deploy dir.
const LOCK_WAIT_SECONDS = 600;
// How long a static deploy waits for another one's nginx test and reload.
const NGINX_LOCK_WAIT_SECONDS = 120;

// The API keeps targets at healthTimeoutSchema (60..900); the script itself
// only needs a positive bound, like buildDeployScript, so tests can be short.
const healthTimeoutSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(HEALTH_TIMEOUT_MAX_SECONDS);

const inputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("jar"),
    deployDir: deployDirSchema,
    jarName: jarNameSchema,
    systemdUnit: systemdUnitSchema,
    healthUrl: healthUrlSchema.nullable(),
    healthTimeoutSeconds: healthTimeoutSecondsSchema,
    stableSeconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(DEFAULT_STABLE_SECONDS),
  }),
  z.object({
    kind: z.literal("static"),
    deployDir: deployDirSchema,
    healthTimeoutSeconds: healthTimeoutSecondsSchema,
  }),
]);

/**
 * Where the artifact is uploaded before the deploy script runs: inside the
 * deploy dir for a jar, beside the web root for static (so the final `mv` is a
 * rename on the same filesystem and nginx never serves a half-written tree).
 */
export function artifactStagingDir(
  kind: ArtifactKind,
  deployDir: string
): string {
  const dir = deployDirSchema.parse(deployDir);
  return kind === "jar"
    ? `${dir}/.opsdeck-incoming`
    : `${dir}.opsdeck-incoming`;
}

/** Reads the artifact image's layer (a `.tar.gz`) from stdin into the staging dir. */
export function buildArtifactExtractCommand(stagingDir: string): string {
  const dir = shq(deployDirSchema.parse(stagingDir));
  return `rm -rf ${dir} && mkdir -p ${dir} && tar -xzf - -C ${dir} bundle/artifact`;
}

/** Throws a ZodError when any field of the input is invalid. */
export function buildArtifactDeployScript(
  input: ArtifactDeployScriptInput
): string {
  const v = inputSchema.parse(input);
  const lines = v.kind === "jar" ? jarLines(v) : staticLines(v.deployDir);
  return `${lines.join("\n")}\n`;
}

// Shared preamble: survive a dropped SSH session, one deploy per target at a
// time, and always remove the staging dir. The cleanup trap is set only once
// the lock is held, so a run that finds the target locked leaves the running
// deploy's staging dir alone.
function preamble(
  lockFile: string,
  staging: string,
  cdDir: string | null
): string[] {
  return [
    "set -eu",
    "trap '' HUP PIPE",
    ...(cdDir === null ? [] : [`cd ${shq(cdDir)}`]),
    `exec 9>${shq(lockFile)}`,
    `flock -w ${LOCK_WAIT_SECONDS} 9 || { echo 'DEPLOY LOCKED'; exit 1; }`,
    `trap ${shq(`rm -rf ${shq(staging)}`)} EXIT`,
  ];
}

function jarLines(v: {
  deployDir: string;
  jarName: string;
  systemdUnit: string;
  healthUrl: string | null;
  healthTimeoutSeconds: number;
  stableSeconds: number;
}): string[] {
  const dir = v.deployDir;
  const staging = artifactStagingDir("jar", dir);
  const unit = shq(v.systemdUnit);
  const target = shq(`${dir}/${v.jarName}`);
  const prevDir = shq(`${dir}/.opsdeck-prev`);
  const prev = shq(`${dir}/.opsdeck-prev/${v.jarName}`);
  return [
    ...preamble(`${dir}/.opsdeck-deploy.lock`, staging, dir),

    // 1. Exactly one non-empty *.jar staged (an unmatched glob stays literal).
    `set -- ${shq(`${staging}/bundle/artifact`)}/*.jar`,
    `if [ "$#" -ne 1 ] || [ ! -f "$1" ] || [ ! -s "$1" ]; then echo 'ARTIFACT INVALID'; exit 1; fi`,
    "staged_jar=$1",

    // 2-3. The unit must exist (checked before anything is stopped or moved),
    //      and starts on boot.
    `systemctl cat ${unit} >/dev/null || { echo 'UNIT NOT FOUND'; exit 1; }`,
    `if [ "$(systemctl is-enabled ${unit} 2>/dev/null || true)" != enabled ]; then`,
    `  systemctl enable ${unit}`,
    `  echo ${shq(`Enabled ${v.systemdUnit}`)}`,
    "fi",

    // 4-6. Stop, keep the current jar as prev, rename the staged one, start.
    `systemctl stop ${unit}`,
    `mkdir -p ${prevDir}`,
    `if [ -e ${target} ]; then mv -f ${target} ${prev}; fi`,
    `mv -f "$staged_jar" ${target}`,
    `systemctl start ${unit}`,

    // 7. Health. A poll is OK when the unit is active with a MainPID > 0 and,
    //    if a URL is set, it answers below 500. A PID different from the
    //    previous poll's restarts the window (a crash loop under Restart=
    //    reads active between crashes). HEALTHY needs consecutive OK polls
    //    spanning stableSeconds; a non-OK poll resets the window.
    `deadline=$(( $(date +%s) + ${v.healthTimeoutSeconds} ))`,
    "ok_since=",
    "prev_pid=",
    "while :; do",
    "  ok=1",
    `  state=$(systemctl show -p ActiveState --value ${unit}) || ok=0`,
    `  pid=$(systemctl show -p MainPID --value ${unit}) || ok=0`,
    `  if [ "$state" != active ]; then ok=0; fi`,
    `  case $pid in ''|*[!0-9]*|0) ok=0 ;; esac`,
    `  if [ "$pid" != "$prev_pid" ]; then ok_since=; fi`,
    "  prev_pid=$pid",
    ...(v.healthUrl === null
      ? []
      : [
          `  if [ "$ok" = 1 ]; then`,
          `    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shq(v.healthUrl)} || true)`,
          `    case $code in [1-4][0-9][0-9]) ;; *) ok=0 ;; esac`,
          "  fi",
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
}

function staticLines(webRoot: string): string[] {
  const staging = artifactStagingDir("static", webRoot);
  const artifact = shq(`${staging}/bundle/artifact`);
  const root = shq(webRoot);
  const next = shq(`${webRoot}.opsdeck-new`);
  const prev = shq(`${webRoot}.opsdeck-prev`);
  return [
    ...preamble(`${webRoot}.opsdeck-deploy.lock`, staging, null),

    // 1. A web root without index.html is not a build.
    `if [ ! -f ${artifact}/index.html ]; then echo 'ARTIFACT INVALID'; exit 1; fi`,

    // 2. The new tree gets the current root's owner, mode and SELinux label
    //    (a first deploy inherits the parent dir's defaults).
    `if [ -e ${root} ]; then`,
    `  chown -R --reference=${root} ${artifact}`,
    `  chmod -R --reference=${root} ${artifact}`,
    `  if selinuxenabled; then chcon -R --reference=${root} ${artifact}; fi`,
    "fi",

    // 3. Next to the root, so the swap below is two renames.
    `rm -rf ${next}`,
    `mv ${artifact} ${next}`,

    // 4. Swap, test and reload one site at a time per host: nginx -t and the
    //    reload cover every site, so two deploys must not interleave.
    `exec 8>${shq(NGINX_LOCK_FILE)}`,
    `flock -w ${NGINX_LOCK_WAIT_SECONDS} 8 || { echo 'DEPLOY LOCKED'; exit 1; }`,
    `rm -rf ${prev}`,
    "had_root=0",
    `if [ -e ${root} ]; then mv ${root} ${prev}; had_root=1; fi`,
    `mv ${next} ${root}`,
    "if ! nginx -t; then",
    `  rm -rf ${root}`,
    `  if [ "$had_root" = 1 ]; then mv ${prev} ${root}; fi`,
    "  echo 'NGINX CONFIG INVALID'",
    "  exit 1",
    "fi",
    "systemctl reload nginx",
    "exec 8>&-",

    // 5.
    "echo 'HEALTHY'",
  ];
}
