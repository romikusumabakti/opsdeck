import { z } from "zod";
import type { TeardownRefusal } from "@/lib/teardown/errors";
import {
  loadTeardownEnvironment,
  type TeardownEnvironment,
} from "@/lib/teardown/repository";

type DirParams = { serverId: string; deployDir: string };

export type TeardownStepSpec =
  | { kind: "check_stack"; params: DirParams }
  | { kind: "archive_database"; params: { serviceId: string } }
  | { kind: "archive_deploy_dir"; params: DirParams }
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

// One path segment: no `.`/`..`, whitespace, quotes or shell metacharacters.
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** The directory without trailing slashes; `/` stays `/`. */
export function normaliseDeployDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed === "" && dir.startsWith("/") ? "/" : trimmed;
}

/**
 * Whether a deploy directory may be archived, brought down and `rm -rf`-ed:
 * absolute, at least two plain segments (so neither `/` nor a top-level dir
 * such as `/deployments`), no `.`/`..` or empty segment, and nothing a shell
 * would read (whitespace, quotes, `$`, `;`, `*`, …). A trailing slash is fine.
 */
export function isSafeDeployDir(dir: string): boolean {
  if (!dir.startsWith("/")) return false;
  const segments = normaliseDeployDir(dir).slice(1).split("/");
  if (segments.length < 2) return false;
  return segments.every(
    (segment) =>
      segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment)
  );
}

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

/** Whether one directory is the other or lies inside it. */
function dirsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The ordered steps that delete an environment: check each stack, archive
 * every database and deploy directory, bring the stacks down, drop shared
 * databases, remove the Cloudflare objects the Panel created (only those whose
 * ids are recorded), remove the deploy directories, then the environment row.
 * Nothing destructive comes before both archives. Refuses an unsafe deploy
 * dir, a dir that overlaps another environment's on the same server, and a
 * database the Panel cannot dump (only Postgres is). Pure.
 */
export function planTeardown(env: TeardownEnvironment): TeardownPlan {
  const dirs: DirParams[] = [];
  const seen = new Set<string>();
  for (const target of env.targets) {
    if (!isSafeDeployDir(target.deployDir)) {
      return { refusal: "unsafeDeployDir" };
    }
    const deployDir = normaliseDeployDir(target.deployDir);
    const key = JSON.stringify([target.serverId, deployDir]);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ serverId: target.serverId, deployDir });
  }

  const shared = dirs.some((dir) =>
    env.otherTargets.some(
      (other) =>
        other.serverId === dir.serverId &&
        dirsOverlap(dir.deployDir, normaliseDeployDir(other.deployDir))
    )
  );
  if (shared) return { refusal: "deployDirShared" };

  if (env.dbServices.some((service) => service.dbType !== "postgres")) {
    return { refusal: "databaseBackupUnsupported" };
  }

  const steps: TeardownStepSpec[] = [];
  for (const params of dirs) steps.push({ kind: "check_stack", params });
  for (const service of env.dbServices) {
    steps.push({ kind: "archive_database", params: { serviceId: service.id } });
  }
  for (const params of dirs) steps.push({ kind: "archive_deploy_dir", params });
  for (const params of dirs) steps.push({ kind: "stack_down", params });
  // In-stack databases went with their stack; only a shared host keeps one.
  for (const service of env.dbServices) {
    if (service.dbKind !== "shared") continue;
    steps.push({ kind: "drop_database", params: { serviceId: service.id } });
  }

  const domain = env.domain;
  if (domain?.kind === "tunnel" && domain.remoteTunnelId) {
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
  if (domain?.zoneId && domain.dnsRecordId) {
    steps.push({
      kind: "remove_dns_record",
      params: { zoneId: domain.zoneId, recordId: domain.dnsRecordId },
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
