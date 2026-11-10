import { z } from "zod";

export type ProvisioningStepSpec =
  | {
      kind: "prepare_deploy_dir";
      params: { serverId: string; deployDir: string };
    }
  | {
      kind: "create_database";
      params: {
        databaseHostId: string;
        database: string;
        role: string;
        passwordVariable: string;
      };
    }
  | {
      kind: "tunnel_route";
      params: {
        zoneId: string;
        remoteTunnelId: string;
        hostname: string;
        service: string;
      };
    }
  | {
      kind: "access_app";
      params: {
        zoneId: string;
        remoteTunnelId: string;
        hostname: string;
        policyId: string;
      };
    }
  | {
      kind: "dns_record";
      params: { zoneId: string; hostname: string; remoteTunnelId: string };
    }
  | { kind: "deploy"; params: { targetId: string; branch: string } };

export type ProvisioningStepKind = ProvisioningStepSpec["kind"];

/**
 * Parses a stored step back into a spec. Params live in a jsonb column and end
 * up in shell commands and SQL identifiers, so the job re-validates them.
 */
export const provisioningStepSpecSchema: z.ZodType<ProvisioningStepSpec> =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("prepare_deploy_dir"),
      params: z.object({
        serverId: z.string().min(1),
        deployDir: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("create_database"),
      params: z.object({
        databaseHostId: z.string().min(1),
        database: z.string().min(1),
        role: z.string().min(1),
        passwordVariable: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("tunnel_route"),
      params: z.object({
        zoneId: z.string().min(1),
        remoteTunnelId: z.string().min(1),
        hostname: z.string().min(1),
        service: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("access_app"),
      params: z.object({
        zoneId: z.string().min(1),
        remoteTunnelId: z.string().min(1),
        hostname: z.string().min(1),
        policyId: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("dns_record"),
      params: z.object({
        zoneId: z.string().min(1),
        hostname: z.string().min(1),
        remoteTunnelId: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("deploy"),
      params: z.object({
        targetId: z.string().min(1),
        branch: z.string().min(1),
      }),
    }),
  ]);

export type ProvisioningPlanErrorCode =
  | "missing_db_fields"
  | "missing_entry_port"
  | "no_targets";

export class ProvisioningPlanError extends Error {
  constructor(readonly code: ProvisioningPlanErrorCode) {
    super(code);
    this.name = "ProvisioningPlanError";
  }
}

export type ProvisioningEnvironment = {
  targets: {
    id: string;
    serverId: string;
    deployDir: string;
    sourceBranch: string;
  }[];
  db: {
    dbKind: string | null;
    databaseHostId: string | null;
    dbName: string | null;
    dbRole: string | null;
    dbPasswordVariable: string | null;
  } | null;
  /**
   * The environment's domain binding. `zoneId` and `remoteTunnelId` are row
   * ids (cloudflare_zones, remote_tunnels); `originHost` is the tunnel's and
   * `entryPort` the environment's. Absent or external: no Cloudflare steps.
   */
  domain?: {
    kind: "tunnel" | "external";
    hostname: string;
    zoneId: string | null;
    remoteTunnelId: string | null;
    originHost: string | null;
    accessPolicyId: string | null;
    entryPort: number | null;
  } | null;
};

/**
 * The ordered steps that bring an environment up: one deploy directory per
 * distinct (server, directory), then the shared database when the binding is
 * `shared`, then for a tunnel domain the Access app (when a policy is set),
 * the route and the DNS record, then one deploy per target. Access comes
 * first so no route or record ever serves the hostname unprotected; an Access
 * app alone gates nothing. Pure: reads nothing but its argument.
 */
export function planProvisioning(
  env: ProvisioningEnvironment
): ProvisioningStepSpec[] {
  if (env.targets.length === 0) throw new ProvisioningPlanError("no_targets");

  const steps: ProvisioningStepSpec[] = [];
  const seen = new Set<string>();
  for (const target of env.targets) {
    const key = JSON.stringify([target.serverId, target.deployDir]);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      kind: "prepare_deploy_dir",
      params: { serverId: target.serverId, deployDir: target.deployDir },
    });
  }

  const db = env.db;
  if (db?.dbKind === "shared") {
    if (
      !(db.databaseHostId && db.dbName && db.dbRole && db.dbPasswordVariable)
    ) {
      throw new ProvisioningPlanError("missing_db_fields");
    }
    steps.push({
      kind: "create_database",
      params: {
        databaseHostId: db.databaseHostId,
        database: db.dbName,
        role: db.dbRole,
        passwordVariable: db.dbPasswordVariable,
      },
    });
  }

  const domain = env.domain;
  if (domain?.kind === "tunnel" && domain.zoneId && domain.remoteTunnelId) {
    if (domain.entryPort === null) {
      throw new ProvisioningPlanError("missing_entry_port");
    }
    const { hostname, remoteTunnelId, zoneId } = domain;
    if (domain.accessPolicyId) {
      steps.push({
        kind: "access_app",
        params: {
          zoneId,
          remoteTunnelId,
          hostname,
          policyId: domain.accessPolicyId,
        },
      });
    }
    steps.push({
      kind: "tunnel_route",
      params: {
        zoneId,
        remoteTunnelId,
        hostname,
        service: `http://${domain.originHost ?? "localhost"}:${domain.entryPort}`,
      },
    });
    steps.push({
      kind: "dns_record",
      params: { zoneId, hostname, remoteTunnelId },
    });
  }

  for (const target of env.targets) {
    steps.push({
      kind: "deploy",
      params: { targetId: target.id, branch: target.sourceBranch },
    });
  }
  return steps;
}

// Key order must not matter when comparing params read back from jsonb.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameStepSpec(
  a: { kind: string; params: unknown },
  b: { kind: string; params: unknown }
): boolean {
  return a.kind === b.kind && canonical(a.params) === canonical(b.params);
}

/**
 * Decides, for a re-plan, which stored steps survive: a `done` step whose kind
 * and params equal a spec stays (each stored step matches at most one spec).
 * Returns, per spec, the id of the step it keeps or null for a new one.
 */
export function matchDoneSteps(
  existing: { id: string; kind: string; params: unknown; status: string }[],
  specs: { kind: string; params: unknown }[]
): (string | null)[] {
  const taken = new Set<string>();
  return specs.map((spec) => {
    const match = existing.find(
      (step) =>
        step.status === "done" &&
        !taken.has(step.id) &&
        sameStepSpec(step, spec)
    );
    if (!match) return null;
    taken.add(match.id);
    return match.id;
  });
}
