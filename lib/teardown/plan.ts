import { z } from "zod";
import type { TeardownRefusal } from "@/lib/teardown/errors";
import {
  dirsCollide,
  isSafeDeployDir,
  normaliseDeployDir,
  normaliseHost,
} from "@/lib/teardown/paths";
import {
  loadTeardownEnvironment,
  type TeardownEnvironment,
} from "@/lib/teardown/repository";

export {
  composeProjectName,
  dirsCollide,
  dirsOverlap,
  isSafeDeployDir,
  normaliseDeployDir,
  normaliseHost,
} from "@/lib/teardown/paths";

type DirParams = { serverId: string; deployDir: string };

export type TeardownStepSpec =
  | { kind: "check_stack"; params: DirParams }
  | { kind: "archive_database"; params: { serviceId: string } }
  | { kind: "archive_deploy_dir"; params: DirParams }
  | { kind: "archive_volumes"; params: DirParams }
  | { kind: "stack_down"; params: DirParams }
  | { kind: "drop_database"; params: { serviceId: string } }
  | {
      kind: "remove_tunnel_route";
      params: { remoteTunnelId: string; hostname: string };
    }
  | { kind: "remove_access_app"; params: { zoneId: string; appId: string } }
  | { kind: "remove_dns_record"; params: { zoneId: string; recordId: string } }
  | { kind: "remove_deploy_dir"; params: DirParams }
  | { kind: "delete_environment"; params: Record<string, never> };

export type TeardownStepKind = TeardownStepSpec["kind"];

const dirParams = z.object({
  serverId: z.string().min(1),
  deployDir: z.string().refine(isSafeDeployDir),
});
const serviceParams = z.object({ serviceId: z.string().min(1) });

/**
 * Parses a stored step back into a spec. Params live in a jsonb column and end
 * up in shell commands, so the job re-validates them (the deploy dir too).
 */
export const teardownStepSpecSchema: z.ZodType<TeardownStepSpec> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("check_stack"), params: dirParams }),
    z.object({ kind: z.literal("archive_database"), params: serviceParams }),
    z.object({ kind: z.literal("archive_deploy_dir"), params: dirParams }),
    z.object({ kind: z.literal("archive_volumes"), params: dirParams }),
    z.object({ kind: z.literal("stack_down"), params: dirParams }),
    z.object({ kind: z.literal("drop_database"), params: serviceParams }),
    z.object({
      kind: z.literal("remove_tunnel_route"),
      params: z.object({
        remoteTunnelId: z.string().min(1),
        hostname: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("remove_access_app"),
      params: z.object({
        zoneId: z.string().min(1),
        appId: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("remove_dns_record"),
      params: z.object({
        zoneId: z.string().min(1),
        recordId: z.string().min(1),
      }),
    }),
    z.object({ kind: z.literal("remove_deploy_dir"), params: dirParams }),
    z.object({
      kind: z.literal("delete_environment"),
      params: z.object({}).strict(),
    }),
  ]) as z.ZodType<TeardownStepSpec>;

export type TeardownPlan =
  | { steps: TeardownStepSpec[] }
  | { refusal: TeardownRefusal };

/**
 * The ordered steps that delete an environment: check each stack, archive
 * every database, deploy directory and stack volume, bring the stacks down, drop shared
 * databases, remove the Cloudflare objects the Panel created (only those whose
 * ids are recorded), remove the deploy directories, then the environment row.
 * Nothing destructive comes before the archives. Refuses an unsafe deploy
 * dir, a dir that collides with another environment's on the same machine
 * (compared by host, so two server rows for one machine count as one), a
 * database the Panel cannot dump (only Postgres is), and a Cloudflare object
 * another environment also records. Pure.
 */
export function planTeardown(env: TeardownEnvironment): TeardownPlan {
  const dirs: DirParams[] = [];
  const machineDirs: { host: string; deployDir: string }[] = [];
  const seen = new Set<string>();
  for (const target of env.targets) {
    if (!isSafeDeployDir(target.deployDir)) {
      return { refusal: "unsafeDeployDir" };
    }
    const deployDir = normaliseDeployDir(target.deployDir);
    machineDirs.push({ host: normaliseHost(target.host), deployDir });
    const key = JSON.stringify([target.serverId, deployDir]);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ serverId: target.serverId, deployDir });
  }

  const shared = machineDirs.some((ours) =>
    env.otherTargets.some(
      (other) =>
        normaliseHost(other.host) === ours.host &&
        dirsCollide(ours.deployDir, normaliseDeployDir(other.deployDir))
    )
  );
  if (shared) return { refusal: "deployDirShared" };

  if (env.dbServices.some((service) => service.dbType !== "postgres")) {
    return { refusal: "databaseBackupUnsupported" };
  }

  const domain = env.domain?.kind === "tunnel" ? env.domain : null;
  const domainShared =
    domain !== null &&
    env.otherDomains.some(
      (other) =>
        (domain.accessAppId !== null &&
          other.accessAppId === domain.accessAppId) ||
        (domain.dnsRecordId !== null &&
          other.dnsRecordId === domain.dnsRecordId)
    );
  if (domainShared) return { refusal: "domainShared" };

  const steps: TeardownStepSpec[] = [];
  for (const params of dirs) steps.push({ kind: "check_stack", params });
  for (const service of env.dbServices) {
    steps.push({ kind: "archive_database", params: { serviceId: service.id } });
  }
  for (const params of dirs) steps.push({ kind: "archive_deploy_dir", params });
  // Named volumes: `down --volumes` deletes them, registered db or not.
  for (const params of dirs) steps.push({ kind: "archive_volumes", params });
  for (const params of dirs) steps.push({ kind: "stack_down", params });
  // In-stack databases went with their stack; only a shared host keeps one.
  for (const service of env.dbServices) {
    if (service.dbKind !== "shared") continue;
    steps.push({ kind: "drop_database", params: { serviceId: service.id } });
  }

  // DNS record, then route, then Access app: at every step in between the
  // hostname either does not resolve or is still behind Access.
  if (domain?.zoneId && domain.dnsRecordId) {
    steps.push({
      kind: "remove_dns_record",
      params: { zoneId: domain.zoneId, recordId: domain.dnsRecordId },
    });
  }
  if (domain?.remoteTunnelId) {
    steps.push({
      kind: "remove_tunnel_route",
      params: {
        remoteTunnelId: domain.remoteTunnelId,
        hostname: domain.hostname,
      },
    });
  }
  if (domain?.zoneId && domain.accessAppId) {
    steps.push({
      kind: "remove_access_app",
      params: { zoneId: domain.zoneId, appId: domain.accessAppId },
    });
  }

  for (const params of dirs) steps.push({ kind: "remove_deploy_dir", params });
  steps.push({ kind: "delete_environment", params: {} });
  return { steps };
}

/** The teardown plan of an environment, or null when it does not exist. */
export async function buildTeardownPlan(
  environmentId: string
): Promise<TeardownPlan | null> {
  const env = await loadTeardownEnvironment(environmentId);
  return env ? planTeardown(env) : null;
}
