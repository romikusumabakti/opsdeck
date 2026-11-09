import { loadServerCredentials } from "@/lib/environments";
import { pgQuoteLiteral } from "@/lib/jobs/commands";
import { privilegedViaStdin } from "@/lib/privileged";
import { provisionedRoleMarker } from "@/lib/provisioning/database";
import { loadDatabaseHost } from "@/lib/provisioning/repository";
import { decryptNullable } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { executeRemoteCommand, redactSecrets } from "@/lib/ssh";
import { HostKeyMismatchError, type SshTarget } from "@/lib/ssh-connect";
import { StepFailed } from "@/lib/teardown/errors";
import {
  composeProjectName,
  dirsCollide,
  dirsOverlap,
  isSafeDeployDir,
  normaliseDeployDir,
  type TeardownStepSpec,
} from "@/lib/teardown/plan";
import {
  loadStackGuard,
  loadTeardownDbService,
  type StackGuard,
} from "@/lib/teardown/repository";

// The teardown steps that act on servers over SSH. Each one re-validates its
// stored params and re-reads the current rows before anything destructive
// (another environment may have appeared since the plan), is idempotent (a
// retry after success changes nothing and returns ok), returns one log line
// and throws StepFailed with a TEARDOWN_ERRORS code. Paths and names reach
// the shell single-quoted; no secret is ever part of a command.
//
// Compose runs as the SSH user, as deploys do (on Podman hosts through the
// `docker` CLI shim); only `rm -rf` is elevated, since containers leave
// root-owned files in bind mounts.

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

// compose-go's project name rules; anything else means we misread it.
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** One remote command; any failure but a host-key mismatch is a StepFailed. */
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
    // Carries its own code, which the UI knows.
    if (error instanceof HostKeyMismatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new StepFailed(
      "serverCommandFailed",
      redactSecrets(message, ctx.secrets)
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

/** deployDirShared when another environment's dir overlaps ours. */
function refuseOverlap(dir: string, guard: StackGuard): void {
  const shared = guard.otherDeployDirs.some((other) =>
    dirsOverlap(dir, normaliseDeployDir(other))
  );
  if (shared) throw new StepFailed("deployDirShared");
}

type StackInspection =
  | { state: "absent" | "nofile" }
  | {
      state: "stack";
      // The dir as the shell sees it, and with symlinks resolved.
      dirs: string[];
      project: string;
      volumes: string[];
      containers: { name: string; workingDir: string }[];
      projectVolumes: string[];
    };

/**
 * One read-only command: whether the dir and a compose file exist, the
 * project `docker compose` resolves there (a `name:` key and
 * COMPOSE_PROJECT_NAME included), its named volumes, and the containers and
 * volumes labelled with that project anywhere on the machine. The resolved
 * config holds the .env's values, so it stays on the server: only its
 * top-level `name:` line comes back.
 */
function inspectCommand(dir: string): string {
  const d = shq(dir);
  const containerFormat = shq(
    '{{.Names}}|{{.Label "com.docker.compose.project.working_dir"}}'
  );
  return [
    `if [ ! -d ${d} ]; then echo absent; exit 0; fi`,
    `cd ${d} || exit 1`,
    "if [ ! -e compose.yaml ] && [ ! -e compose.yml ] && [ ! -e docker-compose.yaml ] && [ ! -e docker-compose.yml ] && ! grep -qs '^COMPOSE_FILE=' .env; then echo nofile; exit 0; fi",
    'echo "pwd $(pwd)"',
    'echo "real $(pwd -P)"',
    "cfg=$(docker compose config) || exit 1",
    `name=$(printf '%s\\n' "$cfg" | sed -n 's/^name: //p' | head -n 1)`,
    'echo "name $name"',
    "vols=$(docker compose config --volumes) || exit 1",
    `printf '%s\\n' "$vols" | sed -n '/./s/^/volume /p'`,
    'if [ -z "$name" ]; then exit 0; fi',
    `cs=$(docker ps -a --filter "label=com.docker.compose.project=$name" --format ${containerFormat}) || exit 1`,
    `printf '%s\\n' "$cs" | sed -n '/./s/^/container /p'`,
    `vs=$(docker volume ls -q --filter "label=com.docker.compose.project=$name") || exit 1`,
    `printf '%s\\n' "$vs" | sed -n '/./s/^/projectvolume /p'`,
  ].join("\n");
}

function parseInspection(output: string): StackInspection {
  const lines = output.split("\n").filter((line) => line.length > 0);
  if (lines[0] === "absent") return { state: "absent" };
  if (lines[0] === "nofile") return { state: "nofile" };
  const inspection = {
    state: "stack" as const,
    dirs: [] as string[],
    project: "",
    volumes: [] as string[],
    containers: [] as { name: string; workingDir: string }[],
    projectVolumes: [] as string[],
  };
  for (const line of lines) {
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "pwd" || key === "real") {
      inspection.dirs.push(normaliseDeployDir(value));
    } else if (key === "name") {
      inspection.project = value.trim();
    } else if (key === "volume") {
      inspection.volumes.push(value);
    } else if (key === "container") {
      const bar = value.indexOf("|");
      inspection.containers.push({
        name: bar < 0 ? value : value.slice(0, bar),
        workingDir: bar < 0 ? "" : value.slice(bar + 1),
      });
    } else if (key === "projectvolume") {
      inspection.projectVolumes.push(value);
    }
  }
  return inspection;
}

/**
 * The run-time checks before a stack is archived or brought down. Refuses
 * - deployDirShared: another environment's dir on the machine overlaps ours,
 *   or would get the same compose project (by its dir name, or by the
 *   project ours actually resolves to), or a container of our project was
 *   started from another dir;
 * - stackHostsSharedDatabase: a container of our project is a registered
 *   database host's or another environment's db service;
 * - databaseNotRegistered: the stack has named volumes and the environment
 *   no db service, so the archive would miss that data.
 * Null when there is no stack (dir or compose file missing).
 */
async function guardStack(
  ctx: TeardownContext,
  params: DirParams
): Promise<{
  dir: string;
  target: SshTarget;
  stack: Extract<StackInspection, { state: "stack" }> | null;
}> {
  const dir = safeDir(params);
  const { guard, target } = await load(ctx, params.serverId);
  const others = guard.otherDeployDirs.map(normaliseDeployDir);
  if (others.some((other) => dirsCollide(dir, other))) {
    throw new StepFailed("deployDirShared");
  }

  const inspection = parseInspection(
    await remote(ctx, target, inspectCommand(dir), {
      timeoutMs: INSPECT_TIMEOUT_MS,
    })
  );
  if (inspection.state !== "stack") return { dir, target, stack: null };

  const { project } = inspection;
  if (!PROJECT_NAME.test(project)) {
    throw new StepFailed(
      "serverCommandFailed",
      `could not read the compose project of ${dir}`
    );
  }
  if (others.some((other) => composeProjectName(other) === project)) {
    throw new StepFailed("deployDirShared");
  }
  const databaseContainers = new Set(guard.databaseContainers);
  if (inspection.containers.some((c) => databaseContainers.has(c.name))) {
    throw new StepFailed("stackHostsSharedDatabase");
  }
  const ourDirs = new Set([dir, ...inspection.dirs]);
  const foreign = inspection.containers.some(
    (c) => c.workingDir === "" || !ourDirs.has(normaliseDeployDir(c.workingDir))
  );
  if (foreign) throw new StepFailed("deployDirShared");
  if (inspection.volumes.length > 0 && !guard.hasDbService) {
    throw new StepFailed("databaseNotRegistered");
  }
  return { dir, target, stack: inspection };
}

/** check_stack: the run-time refusals of guardStack, nothing changed. */
export async function checkStack(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const { dir, stack } = await guardStack(ctx, params);
  if (!stack) return `No compose stack in ${dir}; nothing to check`;
  return `Stack ${stack.project} in ${dir} checked (${stack.containers.length} containers, ${stack.volumes.length} named volumes)`;
}

/**
 * stack_down: `docker compose down --remove-orphans --volumes` in the dir,
 * pinned to the project the checks just read. Ok without a dir, a compose
 * file, or anything left of the project.
 */
export async function stackDown(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const { dir, target, stack } = await guardStack(ctx, params);
  if (!stack) return `No compose stack in ${dir}; nothing to bring down`;
  if (stack.containers.length === 0 && stack.projectVolumes.length === 0) {
    return `Stack ${stack.project} in ${dir} is already down`;
  }
  await remote(
    ctx,
    target,
    `cd ${shq(dir)} && docker compose -p ${shq(stack.project)} down --remove-orphans --volumes`,
    { timeoutMs: STEP_COMMAND_TIMEOUT_MS }
  );
  return `Stack ${stack.project} in ${dir} brought down with its volumes`;
}

/**
 * remove_deploy_dir: `rm -rf --` on the canonical dir, once it is still a
 * safe path and no other environment's dir overlaps it. Tried as the SSH
 * user first, then elevated (container-owned files in bind mounts). Ok when
 * already absent.
 */
export async function removeDeployDir(
  ctx: TeardownContext,
  params: DirParams
): Promise<string> {
  const dir = safeDir(params);
  const { guard, target } = await load(ctx, params.serverId);
  refuseOverlap(dir, guard);
  const d = shq(dir);
  const present = await remote(
    ctx,
    target,
    `if [ -e ${d} ] || [ -L ${d} ]; then echo present; else echo absent; fi`,
    { timeoutMs: INSPECT_TIMEOUT_MS }
  );
  if (present.trim() !== "present") return `${dir} already removed`;
  const rm = `rm -rf -- ${d}`;
  const elevated = privilegedViaStdin(rm, target);
  const command =
    elevated.command === rm ? rm : `${rm} 2>/dev/null || ${elevated.command}`;
  await remote(ctx, target, command, {
    timeoutMs: STEP_COMMAND_TIMEOUT_MS,
    ...(elevated.stdin === undefined ? {} : { stdin: elevated.stdin }),
  });
  return `${dir} removed`;
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
