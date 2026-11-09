import { loadServerCredentials } from "@/lib/environments";
import { pgQuoteLiteral } from "@/lib/jobs/commands";
import { privilegedViaStdin } from "@/lib/privileged";
import { provisionedRoleMarker } from "@/lib/provisioning/database";
import { loadDatabaseHost } from "@/lib/provisioning/repository";
import { decryptNullable } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import {
  executeRemoteCommand,
  type RemoteScriptResult,
  redactSecrets,
  runRemoteScript,
} from "@/lib/ssh";
import { HostKeyMismatchError, type SshTarget } from "@/lib/ssh-connect";
import { StepFailed } from "@/lib/teardown/errors";
import {
  composeProjectName,
  dirsCollide,
  dirsOverlap,
  isSafeDeployDir,
  normaliseDeployDir,
  PARENT_DIRS,
  SYSTEM_TREES,
} from "@/lib/teardown/paths";
import type { TeardownStepSpec } from "@/lib/teardown/plan";
import {
  loadStackGuard,
  loadTeardownDbService,
  type StackGuard,
} from "@/lib/teardown/repository";

// The teardown steps that act on servers over SSH. Each one re-validates its
// stored params and re-reads the current rows before any SSH, then runs ONE
// remote script that repeats the checks on the server and only then acts, so
// nothing can come between the check and `compose down` / `rm`. A refusal is
// a distinct exit code. Steps are idempotent (a retry after success changes
// nothing and returns ok), return one log line and throw StepFailed with a
// TEARDOWN_ERRORS code. Paths and names reach the shell single-quoted; no
// secret is part of a command; compose's stderr (it can quote the compose
// file or .env) is never kept.
//
// Compose runs as the SSH user, as deploys do (on Podman hosts through the
// `docker` CLI shim with the Docker Compose v2 provider, whose banner goes to
// stderr); only `rm -rf` is elevated, since containers leave root-owned files
// in bind mounts.
//
// Known limits: a bind mount another stack has inside the dir is not
// detected; a project network left without containers or volumes, and a
// stack whose compose file was deleted while it runs, are left alone.

const INSPECT_TIMEOUT_MS = 2 * 60_000;
const STEP_COMMAND_TIMEOUT_MS = 10 * 60_000;

export type TeardownContext = {
  environmentId: string;
  runId: string;
  // Plaintext secrets a step loaded; the runner scrubs them from anything
  // stored or logged.
  secrets: string[];
};

type DirParams = Extract<TeardownStepSpec, { kind: "stack_down" }>["params"];
type ServiceParams = Extract<
  TeardownStepSpec,
  { kind: "drop_database" }
>["params"];

// Docker's volume name rule; anything else is refused before it is used.
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// The throwaway container that reads a volume for its archive.
const ARCHIVE_IMAGE = "docker.io/library/busybox:1.37";

// Exit codes of the step scripts.
const EXIT = {
  deployDirShared: 10,
  stackHostsSharedDatabase: 11,
  unreadableProject: 12,
  unresolvablePath: 13,
  unsafeRealDir: 14,
  composeConfigFailed: 20,
  dockerListFailed: 21,
  composeActionFailed: 30,
  removeFailed: 31,
} as const;

/** executeRemoteCommand; any failure but a host-key mismatch is a StepFailed. */
async function remote(
  ctx: TeardownContext,
  target: SshTarget,
  command: string,
  options: { timeoutMs: number; stdin?: string }
): Promise<string> {
  try {
    return await executeRemoteCommand(target, command, {
      ...options,
      secrets: ctx.secrets,
    });
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new StepFailed(
      "serverCommandFailed",
      redactSecrets(message, ctx.secrets)
    );
  }
}

/** Runs a step script; connection errors become serverCommandFailed. */
async function script(
  ctx: TeardownContext,
  target: SshTarget,
  body: string,
  options: { timeoutMs: number; stdin?: string }
): Promise<RemoteScriptResult> {
  try {
    return await runRemoteScript(target, `sh -c ${shq(body)}`, options);
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new StepFailed(
      "serverCommandFailed",
      redactSecrets(message, ctx.secrets)
    );
  }
}

/**
 * The step's StepFailed for a non-zero exit, with a fixed detail. Only the
 * first stderr line of `docker ps`/`volume ls` or `rm`/`sudo` is kept;
 * never anything compose printed.
 */
function failed(ctx: TeardownContext, result: RemoteScriptResult): StepFailed {
  const firstLine = () =>
    redactSecrets(result.stderr.split("\n")[0]?.trim() ?? "", ctx.secrets);
  switch (result.code) {
    case EXIT.deployDirShared:
      return new StepFailed("deployDirShared");
    case EXIT.stackHostsSharedDatabase:
      return new StepFailed("stackHostsSharedDatabase");
    case EXIT.unreadableProject:
      return new StepFailed(
        "serverCommandFailed",
        "could not read the compose project of this or another environment's dir"
      );
    case EXIT.unresolvablePath:
      return new StepFailed(
        "serverCommandFailed",
        "could not resolve the real path of a deploy dir on the server"
      );
    case EXIT.unsafeRealDir:
      return new StepFailed("unsafeDeployDir");
    case EXIT.composeConfigFailed:
      return new StepFailed(
        "serverCommandFailed",
        "docker compose config failed"
      );
    case EXIT.dockerListFailed:
      return new StepFailed(
        "serverCommandFailed",
        `docker could not list the project's containers or volumes: ${firstLine()}`
      );
    case EXIT.composeActionFailed:
      return new StepFailed("serverCommandFailed", "docker compose failed");
    case EXIT.removeFailed:
      return new StepFailed(
        "serverCommandFailed",
        `the deploy dir could not be removed: ${firstLine()}`
      );
    default:
      return new StepFailed(
        "serverCommandFailed",
        `the step script exited with ${result.code ?? "a signal"}`
      );
  }
}

/** The canonical deploy dir, or unsafeDeployDir before any SSH. */
function safeDir(params: DirParams): string {
  if (!isSafeDeployDir(params.deployDir)) {
    throw new StepFailed("unsafeDeployDir");
  }
  const dir = normaliseDeployDir(params.deployDir);
  if (!isSafeDeployDir(dir)) throw new StepFailed("unsafeDeployDir");
  return dir;
}

/** Current rows and SSH credentials for a step on `serverId`. */
async function load(
  ctx: TeardownContext,
  serverId: string
): Promise<{ guard: StackGuard; target: SshTarget }> {
  const guard = await loadStackGuard(ctx.environmentId, serverId);
  const creds = await loadServerCredentials(serverId);
  if (!guard || !creds) {
    throw new StepFailed("serverCommandFailed", `server ${serverId} not found`);
  }
  if (creds.password) ctx.secrets.push(creds.password);
  return { guard, target: { ...creds, run: ctx.runId } };
}

// Shell helpers every step script starts with. `under A B`: A is B or lies
// inside it (B = / covers every absolute path). `resolved P`: P with every
// symlink resolved, or a non-zero status; never P unresolved, since an
// unresolved path would hide an overlap. `realpath -m` (GNU and uutils
// coreutils) first; where it has no -m (busybox), the deepest existing
// ancestor is resolved with `realpath`/`readlink -f` and the rest appended.
// Callers exit unresolvablePath on failure.
const SHELL_HELPERS = [
  'under() { if [ "$2" = / ]; then return 0; fi; case "$1/" in "$2"/*) return 0;; esac; return 1; }',
  'overlap() { under "$1" "$2" || under "$2" "$1"; }',
  [
    "resolved() {",
    '  realpath -m -- "$1" 2>/dev/null && return 0',
    '  case "$1" in /*) ;; *) return 1;; esac',
    "  r_p=$1; r_rest=",
    '  while [ ! -e "$r_p" ] && [ ! -L "$r_p" ]; do',
    `    r_rest=/\${r_p##*/}$r_rest; r_p=\${r_p%/*}; [ -n "$r_p" ] || r_p=/`,
    "  done",
    '  r_real=$(realpath -- "$r_p" 2>/dev/null) || r_real=$(readlink -f -- "$r_p" 2>/dev/null) || return 1',
    '  case "$r_real" in /*) ;; *) return 1;; esac',
    `  if [ "$r_real" = / ]; then printf '%s\\n' "\${r_rest:-/}"; else printf '%s%s\\n' "$r_real" "$r_rest"; fi`,
    "}",
  ].join("\n"),
];

/**
 * The checks before a stack is touched, as script lines run on the server.
 * Prints `state absent`/`state nofile` and exits 0 when there is no stack;
 * otherwise sets $name, $cs (containers) and $vs (volumes) and prints
 * `project`, `containers` and `volume` lines. Refuses (exit code):
 * - deployDirShared: another environment's dir overlaps ours once both are
 *   resolved (symlinks), or its compose project, as compose resolves it
 *   there (`name:`, COMPOSE_PROJECT_NAME; the dir name when it has no
 *   compose file), is ours; or a container of our project was started from
 *   another dir (or carries no working dir label);
 * - stackHostsSharedDatabase: a container of our project is a registered
 *   database host's or another environment's db container;
 * - unreadableProject: a project name cannot be read or is not one compose
 *   could produce (YAML quotes are stripped first).
 * Compose's stderr goes to /dev/null: it can quote the compose file or .env.
 * The resolved config holds the .env's values and never leaves the server;
 * only its top-level `name:` is read.
 */
function stackGuardLines(
  dir: string,
  guard: StackGuard,
  others: string[]
): string[] {
  const hasCompose = (d: string) =>
    `{ [ -e ${d}/compose.yaml ] || [ -e ${d}/compose.yml ] || [ -e ${d}/docker-compose.yaml ] || [ -e ${d}/docker-compose.yml ] || grep -qs '^COMPOSE_FILE=' ${d}/.env; }`;
  const dbList = guard.databaseContainers.map(shq).join(" ");
  const containerFormat = shq(
    '{{.Names}}|{{.Label "com.docker.compose.project.working_dir"}}'
  );
  return [
    `D=${shq(dir)}`,
    ...SHELL_HELPERS,
    'valid() { case "$1" in ""|[!a-z0-9]*|*[!a-z0-9_-]*) return 1;; esac; return 0; }',
    // The project compose resolves in dir $1, quotes stripped.
    `project_in() { cfg=$(cd "$1" && docker compose config 2>/dev/null) || return 1; printf '%s\\n' "$cfg" | sed -n 's/^name: //p' | head -n 1 | sed -e "s/^[\\"']//" -e "s/[\\"']\\$//"; }`,
    `if [ ! -d "$D" ]; then echo 'state absent'; exit 0; fi`,
    `cd "$D" || exit ${EXIT.dockerListFailed}`,
    `if ! ${hasCompose('"$D"')}; then echo 'state nofile'; exit 0; fi`,
    `real=$(pwd -P) || exit ${EXIT.dockerListFailed}`,
    `name=$(project_in "$D") || exit ${EXIT.composeConfigFailed}`,
    `valid "$name" || exit ${EXIT.unreadableProject}`,
    'echo "project $name"',
    // $1 another environment's dir as stored, $2 its dir-derived project.
    "check_other() {",
    `  o_real=$(resolved "$1") || exit ${EXIT.unresolvablePath}`,
    `  if overlap "$real" "$o_real" || overlap "$D" "$1"; then exit ${EXIT.deployDirShared}; fi`,
    `  if [ -d "$1" ] && ${hasCompose('"$1"')}; then`,
    `    o_name=$(project_in "$1") || exit ${EXIT.unreadableProject}`,
    `    valid "$o_name" || exit ${EXIT.unreadableProject}`,
    "  else",
    "    o_name=$2",
    "  fi",
    `  if [ "$o_name" = "$name" ]; then exit ${EXIT.deployDirShared}; fi`,
    "}",
    ...others.map(
      (other) => `check_other ${shq(other)} ${shq(composeProjectName(other))}`
    ),
    `cs=$(docker ps -a --filter "label=com.docker.compose.project=$name" --format ${containerFormat}) || exit ${EXIT.dockerListFailed}`,
    "while IFS='|' read -r c_name c_dir; do",
    '  [ -n "$c_name" ] || continue',
    `  for db in ${dbList}; do if [ "$c_name" = "$db" ]; then exit ${EXIT.stackHostsSharedDatabase}; fi; done`,
    `  [ -n "$c_dir" ] || exit ${EXIT.deployDirShared}`,
    '  if [ "$c_dir" != "$D" ]; then',
    `    c_real=$(resolved "$c_dir") || exit ${EXIT.deployDirShared}`,
    `    [ "$c_real" = "$real" ] || exit ${EXIT.deployDirShared}`,
    "  fi",
    "done <<EOF_CONTAINERS",
    "$cs",
    "EOF_CONTAINERS",
    `vs=$(docker volume ls -q --filter "label=com.docker.compose.project=$name") || exit ${EXIT.dockerListFailed}`,
    `echo "containers $(printf '%s\\n' "$cs" | grep -c .)"`,
    `printf '%s\\n' "$vs" | sed -n '/./s/^/volume /p'`,
  ];
}

type StackReport =
  | { state: "absent" | "nofile" }
  | {
      state: "stack";
      project: string;
      containers: number;
      volumes: string[];
      done: string | null;
    };

function parseReport(stdout: string): StackReport {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const state = lines.find((l) => l.startsWith("state "))?.slice(6);
  const project = lines.find((l) => l.startsWith("project "))?.slice(8);
  if (project === undefined) {
    if (state === "absent" || state === "nofile") return { state };
    throw new StepFailed("serverCommandFailed", "unexpected step output");
  }
  const volumes = lines
    .filter((l) => l.startsWith("volume "))
    .map((l) => l.slice(7));
  if (volumes.some((v) => !VOLUME_NAME.test(v))) {
    throw new StepFailed("serverCommandFailed", "unexpected volume name");
  }
  const count = lines.find((l) => l.startsWith("containers "))?.slice(11);
  return {
    state: "stack",
    project,
    containers: Number(count ?? 0),
    volumes,
    done: state ?? null,
  };
}

/** Checks in TS, then the guard plus `tail` in one remote script. */
async function runStackStep(
  ctx: TeardownContext,
  params: DirParams,
  tail: string[]
): Promise<{ dir: string; report: StackReport }> {
  const dir = safeDir(params);
  const { guard, target } = await load(ctx, params.serverId);
  const others = guard.otherDeployDirs.map(normaliseDeployDir);
  if (others.some((other) => dirsCollide(dir, other))) {
    throw new StepFailed("deployDirShared");
  }
  const result = await script(
    ctx,
    target,
    [...stackGuardLines(dir, guard, others), ...tail].join("\n"),
    { timeoutMs: STEP_COMMAND_TIMEOUT_MS }
  );
  if (result.code !== 0) throw failed(ctx, result);
  return { dir, report: parseReport(result.stdout) };
}

/** check_stack: the guard's refusals; nothing is changed. */
export async function checkStack(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const { dir, report } = await runStackStep(ctx, params, []);
  if (report.state !== "stack") {
    return `No compose stack in ${dir}; nothing to check`;
  }
  return `Stack ${report.project} in ${dir} checked (${report.containers} containers, ${report.volumes.length} volumes)`;
}

/**
 * The first half of archive_volumes: after the guard, `docker compose stop`
 * so the volumes are consistent while they are read, then the project's
 * real volumes (labelled with its name), each checked against Docker's name
 * rule. No volumes when there is no stack.
 */
export async function stopProjectForArchive(
  ctx: TeardownContext,
  params: DirParams
): Promise<{ message: string; project: string | null; volumes: string[] }> {
  const { dir, report } = await runStackStep(ctx, params, [
    `docker compose -p "$name" stop >/dev/null 2>&1 || exit ${EXIT.composeActionFailed}`,
  ]);
  if (report.state !== "stack") {
    return {
      message: `No compose stack in ${dir}; no volumes to archive`,
      project: null,
      volumes: [],
    };
  }
  return {
    message: `Stack ${report.project} in ${dir} stopped; ${report.volumes.length} volumes to archive`,
    project: report.project,
    volumes: report.volumes,
  };
}

/**
 * The command that writes one volume as a gzipped tar to stdout: a
 * throwaway container with no network and no log driver (the stream would
 * otherwise be logged) mounts it read-only. The name must pass Docker's
 * rule, so it cannot carry a mount option or a path.
 */
export function volumeArchiveCommand(volume: string): string {
  if (!VOLUME_NAME.test(volume)) {
    throw new StepFailed("serverCommandFailed", "invalid volume name");
  }
  return `docker run --rm --network none --log-driver none -v ${shq(`${volume}:/v:ro`)} ${ARCHIVE_IMAGE} tar -C /v -czf - .`;
}

/**
 * stack_down: after the guard, in the same script, `docker compose down
 * --remove-orphans --volumes` pinned to the project just checked. Ok without
 * a dir, a compose file, or anything left of the project.
 */
export async function stackDown(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const { dir, report } = await runStackStep(ctx, params, [
    `if [ -z "$cs" ] && [ -z "$vs" ]; then echo 'state down'; exit 0; fi`,
    `docker compose -p "$name" down --remove-orphans --volumes >/dev/null 2>&1 || exit ${EXIT.composeActionFailed}`,
    "echo 'state removed'",
  ]);
  if (report.state !== "stack") {
    return `No compose stack in ${dir}; nothing to bring down`;
  }
  if (report.done === "down") {
    return `Stack ${report.project} in ${dir} is already down`;
  }
  return `Stack ${report.project} in ${dir} brought down with its volumes`;
}

/**
 * remove_deploy_dir: `rm -rf --` on the canonical dir, once it is still a
 * safe path and no other environment's dir overlaps it, as stored and,
 * within the same script, once resolved on the server. What is removed is
 * the resolved real dir (re-checked as isSafeDeployDir does: two segments,
 * no system tree, not a parent of real data), plus the stored path when it
 * is itself a symlink. Tried as the SSH user first, then elevated
 * (container-owned files in bind mounts). Ok when already absent.
 */
export async function removeDeployDir(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const dir = safeDir(params);
  const { guard, target } = await load(ctx, params.serverId);
  const others = guard.otherDeployDirs.map(normaliseDeployDir);
  if (others.some((other) => dirsOverlap(dir, other))) {
    throw new StepFailed("deployDirShared");
  }
  const rm = 'rm -rf -- "$real" "$D"';
  const elevated = privilegedViaStdin(rm, target);
  const remove =
    elevated.command === rm ? rm : `${rm} 2>/dev/null || ${elevated.command}`;
  const parents = [...PARENT_DIRS].map(shq).join("|");
  const body = [
    `D=${shq(dir)}`,
    ...SHELL_HELPERS,
    `if [ ! -e "$D" ] && [ ! -L "$D" ]; then echo 'state absent'; exit 0; fi`,
    `real=$(resolved "$D") || exit ${EXIT.unresolvablePath}`,
    ...others.flatMap((other) => [
      `o_real=$(resolved ${shq(other)}) || exit ${EXIT.unresolvablePath}`,
      `if overlap "$real" "$o_real"; then exit ${EXIT.deployDirShared}; fi`,
    ]),
    `case "$real" in /?*/?*) ;; *) exit ${EXIT.unsafeRealDir};; esac`,
    `for t in ${SYSTEM_TREES.map(shq).join(" ")}; do if under "$real" "$t"; then exit ${EXIT.unsafeRealDir}; fi; done`,
    `case "$real" in ${parents}) exit ${EXIT.unsafeRealDir};; /home/*/*) ;; /home/*) exit ${EXIT.unsafeRealDir};; esac`,
    `${remove} || exit ${EXIT.removeFailed}`,
    "echo 'state removed'",
  ].join("\n");
  const result = await script(ctx, target, body, {
    timeoutMs: STEP_COMMAND_TIMEOUT_MS,
    ...(elevated.stdin === undefined ? {} : { stdin: elevated.stdin }),
  });
  if (result.code !== 0) throw failed(ctx, result);
  return result.stdout.includes("state absent")
    ? `${dir} already removed`
    : `${dir} removed`;
}

const PSQL = "psql -U postgres -X -q -At -v ON_ERROR_STOP=1";

/**
 * drop_database: drops the environment's database on its shared host, but
 * only one the Panel provisioned for this environment (its owner carries the
 * environment's role marker), then the environment's marked roles that own
 * nothing any more. A database someone else made is left in place. Ok when
 * nothing is left.
 */
export async function dropDatabase(
  ctx: TeardownContext,
  params: ServiceParams
): Promise<string> {
  const service = await loadTeardownDbService(params.serviceId);
  if (
    !service ||
    service.environmentId !== ctx.environmentId ||
    service.role !== "db" ||
    service.dbKind !== "shared" ||
    !service.databaseHostId ||
    !service.dbName
  ) {
    throw new StepFailed("databaseNotRegistered");
  }
  const host = await loadDatabaseHost(service.databaseHostId);
  if (!host) throw new StepFailed("databaseNotRegistered");
  const password = decryptNullable(host.server.password);
  if (password) ctx.secrets.push(password);
  const target: SshTarget = {
    serverId: host.server.id,
    host: host.server.host,
    username: host.server.username,
    password,
    auth: host.server.auth,
    run: ctx.runId,
  };

  const database = service.dbName;
  const dbLit = pgQuoteLiteral(database);
  const markerLit = pgQuoteLiteral(provisionedRoleMarker(ctx.environmentId));
  const ownedByUs = `shobj_description(datdba, 'pg_authid') IS NOT DISTINCT FROM ${markerLit}`;
  const markedRoles = `SELECT rolname FROM pg_roles WHERE shobj_description(oid, 'pg_authid') IS NOT DISTINCT FROM ${markerLit}`;
  const probe = [
    "SELECT",
    `CASE WHEN NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbLit}) THEN 'absent'`,
    `WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbLit} AND ${ownedByUs}) THEN 'marked'`,
    "ELSE 'unmarked' END",
    `|| '|' || (SELECT count(*) FROM (${markedRoles}) r)`,
  ].join(" ");
  const container = shq(host.containerName);
  const [status, roles] = (
    await remote(
      ctx,
      target,
      `docker exec ${container} ${PSQL} -c ${shq(probe)}`,
      {
        timeoutMs: INSPECT_TIMEOUT_MS,
      }
    )
  )
    .trim()
    .split("|");
  if (status !== "absent" && status !== "marked" && status !== "unmarked") {
    throw new StepFailed(
      "serverCommandFailed",
      `could not read database ${database}`
    );
  }
  if (status !== "marked" && roles === "0") {
    return status === "absent"
      ? `Database ${database} already absent`
      : `Database ${database} was not created by the Panel for this environment; left in place`;
  }

  // A role still owning something elsewhere is kept rather than failing the
  // teardown. The DO body is an ordinary literal, as in provisioning.
  const dropRoles = [
    "DECLARE r record;",
    "BEGIN",
    `  FOR r IN ${markedRoles} LOOP`,
    "    BEGIN",
    "      EXECUTE format('DROP ROLE %I', r.rolname);",
    "    EXCEPTION WHEN dependent_objects_still_exist THEN",
    "      RAISE NOTICE 'role % still owns objects; kept', r.rolname;",
    "    END;",
    "  END LOOP;",
    "END",
  ].join("\n");
  const sql = [
    "\\set ON_ERROR_STOP on",
    // \gexec runs the row as a statement: none unless the database is ours.
    // DROP DATABASE cannot run inside DO.
    `SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE datname = ${dbLit} AND ${ownedByUs} \\gexec`,
    `DO ${pgQuoteLiteral(dropRoles)};`,
    "",
  ].join("\n");
  await remote(ctx, target, `docker exec -i ${container} ${PSQL}`, {
    timeoutMs: STEP_COMMAND_TIMEOUT_MS,
    stdin: sql,
  });
  return status === "marked"
    ? `Database ${database} dropped`
    : `Database ${database} ${status === "absent" ? "already absent" : "left in place (not created by the Panel)"}; its leftover roles dropped`;
}
