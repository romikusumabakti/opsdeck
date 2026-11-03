import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireProjectPermission } from "@/lib/authz";
import type { DeployTarget } from "@/lib/db/schema";
import {
  deleteTarget,
  environmentUsesServer,
  findBuild,
  getDeployApp,
  getTarget,
  listTargetsForEnvironment,
  type TargetState,
  upsertTarget,
} from "@/lib/deploy/repository";
import {
  appKeySchema,
  branchSchema,
  composeServiceSchema,
  deployDirSchema,
  envVarNameSchema,
} from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { uuidSchema } from "@/lib/validation";
import { requestDeployment } from "@/server/services/deployments";

const fail = (status: 404 | 409 | 503, message: string): never => {
  throw new HTTPException(status, { message });
};

// Free-form text goes into the server script, so these are deliberately narrow.
const servicesSchema = z
  .array(composeServiceSchema)
  .min(1)
  .max(20)
  .refine((list) => new Set(list).size === list.length, "Duplicate service");
const preStartCommandSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]*$/, "Must be a single line");
const healthUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);
// The script waits stableSeconds (30) and then polls, so less cannot succeed.
const healthTimeoutSchema = z.number().int().min(60).max(3600);

export const createTargetSchema = z.object({
  environmentId: uuidSchema,
  appKey: appKeySchema,
  serverId: uuidSchema,
  sourceBranch: branchSchema,
  autoDeploy: z.boolean().default(false),
  deployDir: deployDirSchema,
  services: servicesSchema,
  tagVariable: envVarNameSchema.default("IMAGE_TAG"),
  preStartCommand: preStartCommandSchema.nullish(),
  healthUrl: healthUrlSchema.nullish(),
  healthTimeoutSeconds: healthTimeoutSchema.default(180),
  backupBeforeDeploy: z.boolean().default(false),
});

// The app and environment of a target are fixed once it exists: its history
// (builds, deployments) is keyed to them.
export const updateTargetSchema = z
  .object({
    serverId: uuidSchema,
    sourceBranch: branchSchema,
    autoDeploy: z.boolean(),
    deployDir: deployDirSchema,
    services: servicesSchema,
    tagVariable: envVarNameSchema,
    preStartCommand: preStartCommandSchema.nullable(),
    healthUrl: healthUrlSchema.nullable(),
    healthTimeoutSeconds: healthTimeoutSchema,
    backupBeforeDeploy: z.boolean(),
  })
  .partial()
  .strict();

async function requireTarget(id: string): Promise<DeployTarget> {
  return (await getTarget(id)) ?? fail(404, "Target not found");
}

async function requireServerInEnvironment(
  environmentId: string,
  serverId: string
) {
  if (!(await environmentUsesServer(environmentId, serverId))) {
    throw new HTTPException(400, {
      message: "Server is not used by this environment",
    });
  }
}

export async function listDeployTargets(
  environmentId: string
): Promise<TargetState[]> {
  await requireProjectPermission({ environmentId }, { deploy: ["view"] });
  return listTargetsForEnvironment(environmentId);
}

export async function createDeployTarget(
  input: z.infer<typeof createTargetSchema>
): Promise<DeployTarget> {
  await requireProjectPermission(
    { environmentId: input.environmentId },
    { deploy: ["configure"] }
  );
  if (!(await getDeployApp(input.appKey))) fail(404, "Deploy app not found");
  await requireServerInEnvironment(input.environmentId, input.serverId);
  try {
    return await upsertTarget({
      ...input,
      preStartCommand: input.preStartCommand ?? null,
      healthUrl: input.healthUrl ?? null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail(409, "This app already has a target in the environment");
    }
    throw error;
  }
}

export async function updateDeployTarget(
  id: string,
  changes: z.infer<typeof updateTargetSchema>
): Promise<DeployTarget> {
  const target = await requireTarget(id);
  await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["configure"] }
  );
  if (changes.serverId) {
    await requireServerInEnvironment(target.environmentId, changes.serverId);
  }
  return upsertTarget({ ...changes, id });
}

export async function deleteDeployTarget(id: string): Promise<void> {
  const target = await requireTarget(id);
  await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["configure"] }
  );
  await deleteTarget(id);
}

function requireDeployEnabled() {
  if (!process.env.DEPLOY_REGISTRY) fail(503, "Deploy disabled");
}

/** Manual deploy of a tag that CI built for the target's app and branch. */
export async function deployTag(
  targetId: string,
  tag: string
): Promise<{ deploymentId: string; runId: string }> {
  const target = await requireTarget(targetId);
  const { session } = await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["run"] }
  );
  requireDeployEnabled();
  const build = await findBuild(target.appKey, tag);
  if (!build || build.branch !== target.sourceBranch) {
    fail(404, "Build not found");
  }
  return requestDeployment({
    targetId: target.id,
    tag,
    trigger: "manual",
    userId: session.user.id,
    buildId: build?.id ?? null,
  });
}

/** Deploys the target's previous successful tag again, as a new deployment. */
export async function rollbackTarget(
  targetId: string
): Promise<{ deploymentId: string; runId: string }> {
  const target = await requireTarget(targetId);
  const { session } = await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["rollback"] }
  );
  requireDeployEnabled();
  const state = (await listTargetsForEnvironment(target.environmentId)).find(
    (t) => t.id === target.id
  );
  const tag = state?.previousTag;
  if (!tag) return fail(409, "No previous successful deploy");
  const build = await findBuild(target.appKey, tag);
  return requestDeployment({
    targetId: target.id,
    tag,
    trigger: "rollback",
    userId: session.user.id,
    buildId: build?.id ?? null,
  });
}
