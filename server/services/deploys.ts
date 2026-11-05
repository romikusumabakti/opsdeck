import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { assertTargetMatchesEnvironmentApp, getComponent } from "@/lib/apps";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import type { DeployTarget } from "@/lib/db/schema";
import { TAG_VARIABLE_IS_VARIABLE_MESSAGE } from "@/lib/deploy/errors";
import {
  deleteTarget,
  environmentUsesServer,
  findBuild,
  getEnvironmentForLock,
  getTagState,
  getTarget,
  listTargetsForEnvironment,
  supersedeHeldDeployments,
  type TargetState,
  upsertTarget,
} from "@/lib/deploy/repository";
import {
  branchSchema,
  componentKeySchema,
  deployDirSchema,
  envVarNameSchema,
  healthTimeoutSchema,
  healthUrlSchema,
  preStartCommandSchema,
  servicesSchema,
} from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { uuidSchema } from "@/lib/validation";
import { RESERVED_PREFIX_MESSAGE } from "@/lib/variables/errors";
import { getVariable } from "@/lib/variables/repository";
import { hasReservedPrefix } from "@/lib/variables/validation";
import { assertNotDeployLocked } from "@/server/services/deploy-locks";
import {
  type RequestedDeployment,
  requestDeployment,
} from "@/server/services/deployments";

const fail = (status: 404 | 409 | 503, message: string): never => {
  throw new HTTPException(status, { message });
};

// The deploy writes the tag line into the project's `.env`, so the name
// follows the same reserved-prefix rule as the variables there.
const tagVariableSchema = envVarNameSchema.refine(
  (name) => !hasReservedPrefix(name),
  RESERVED_PREFIX_MESSAGE
);

export const createTargetSchema = z.object({
  environmentId: uuidSchema,
  componentKey: componentKeySchema,
  serverId: uuidSchema,
  sourceBranch: branchSchema,
  autoDeploy: z.boolean().default(false),
  deployDir: deployDirSchema,
  services: servicesSchema,
  tagVariable: tagVariableSchema.default("IMAGE_TAG"),
  preStartCommand: preStartCommandSchema.nullish(),
  healthUrl: healthUrlSchema.nullish(),
  healthTimeoutSeconds: healthTimeoutSchema.default(180),
  backupBeforeDeploy: z.boolean().default(false),
});

// The component and environment of a target are fixed once it exists: its history
// (builds, deployments) is keyed to them.
export const updateTargetSchema = z
  .object({
    serverId: uuidSchema,
    sourceBranch: branchSchema,
    autoDeploy: z.boolean(),
    deployDir: deployDirSchema,
    services: servicesSchema,
    tagVariable: tagVariableSchema,
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

// The deploy writes the tag line itself, so the tag variable may not also be
// one of the environment's variables (the variables API refuses the reverse).
async function requireTagVariableFree(
  environmentId: string,
  tagVariable: string
) {
  if (await getVariable(environmentId, tagVariable)) {
    fail(409, TAG_VARIABLE_IS_VARIABLE_MESSAGE);
  }
}

// Target fields whose old and new values go to the activity log. The others
// (the server's id, the pre-start command, which may carry a secret) are
// logged as "changed" only.
const LOGGED_VALUES = [
  "autoDeploy",
  "sourceBranch",
  "deployDir",
  "services",
  "tagVariable",
  "healthUrl",
  "healthTimeoutSeconds",
  "backupBeforeDeploy",
] as const satisfies readonly (keyof DeployTarget)[];

type TargetChanges = z.infer<typeof updateTargetSchema>;

/**
 * The fields an update really changes, in schema order, and one
 * `name: old → new` (or `name: changed`) entry each for the activity log.
 */
export function describeTargetChanges(
  before: DeployTarget,
  changes: TargetChanges
): { fields: string[]; changes: string[] } {
  const fields = (
    Object.keys(updateTargetSchema.shape) as (keyof TargetChanges)[]
  ).filter(
    (field) =>
      changes[field] !== undefined &&
      JSON.stringify(changes[field]) !== JSON.stringify(before[field])
  );
  return {
    fields,
    changes: fields.map((field) =>
      (LOGGED_VALUES as readonly string[]).includes(field)
        ? `${field}: ${JSON.stringify(before[field])} → ${JSON.stringify(changes[field])}`
        : `${field}: changed`
    ),
  };
}

/** One activity entry for a change to a deploy target of an environment. */
async function auditTarget(
  actorId: string,
  target: Pick<DeployTarget, "environmentId" | "componentKey">,
  action: string,
  data: Record<string, string> = {}
): Promise<void> {
  const environment = await getEnvironmentForLock(target.environmentId);
  await recordActivity({
    actorId,
    action,
    entityType: "environment",
    entityId: target.environmentId,
    data: {
      environment: environment?.name ?? target.environmentId,
      component: target.componentKey,
      ...data,
    },
  });
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
  const { session } = await requireProjectPermission(
    { environmentId: input.environmentId },
    { deploy: ["configure"] }
  );
  if (!(await getComponent(input.componentKey))) {
    fail(404, "Component not found");
  }
  await requireServerInEnvironment(input.environmentId, input.serverId);
  await requireTagVariableFree(input.environmentId, input.tagVariable);
  let created: DeployTarget;
  try {
    created = await db.transaction(async (tx) => {
      await assertTargetMatchesEnvironmentApp(
        input.environmentId,
        input.componentKey,
        tx
      );
      return upsertTarget(
        {
          ...input,
          preStartCommand: input.preStartCommand ?? null,
          healthUrl: input.healthUrl ?? null,
        },
        tx
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail(
        409,
        "This component already has a target in the environment"
      );
    }
    throw error;
  }
  await auditTarget(session.user.id, created, "deployTarget.created");
  return created;
}

export async function updateDeployTarget(
  id: string,
  changes: z.infer<typeof updateTargetSchema>
): Promise<DeployTarget> {
  const target = await requireTarget(id);
  const { session } = await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["configure"] }
  );
  if (changes.serverId) {
    await requireServerInEnvironment(target.environmentId, changes.serverId);
  }
  if (changes.tagVariable) {
    await requireTagVariableFree(target.environmentId, changes.tagVariable);
  }
  // Builds held by the deploy lock were meant for the old settings: once the
  // target stops auto-deploying or follows another branch, they must not
  // deploy on unlock. Same transaction as the change. (No deploy-lock row is
  // touched here, so the lock order of lib/deploy/repository is unaffected.)
  const dropHeld =
    changes.autoDeploy === false ||
    (changes.sourceBranch !== undefined &&
      changes.sourceBranch !== target.sourceBranch);
  const updated = await db.transaction(async (tx) => {
    const row = await upsertTarget({ ...changes, id }, tx);
    if (dropHeld) await supersedeHeldDeployments(id, tx);
    return row;
  });
  const changed = describeTargetChanges(target, changes);
  if (changed.fields.length > 0) {
    await auditTarget(session.user.id, target, "deployTarget.updated", {
      fields: changed.fields.join(", "),
      changes: changed.changes.join("; "),
    });
  }
  return updated;
}

export async function deleteDeployTarget(id: string): Promise<void> {
  const target = await requireTarget(id);
  const { session } = await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["configure"] }
  );
  await deleteTarget(id);
  await auditTarget(session.user.id, target, "deployTarget.deleted");
}

// Only `auto` deployments are ever held; a manual deploy or rollback is
// refused while locked, so it always comes back queued with its run.
function queuedRun(requested: RequestedDeployment): {
  deploymentId: string;
  runId: string;
} {
  if (requested.status === "held") {
    throw new Error(`Deployment ${requested.deploymentId} was held`);
  }
  return { deploymentId: requested.deploymentId, runId: requested.runId };
}

function requireDeployEnabled() {
  if (!process.env.DEPLOY_REGISTRY) fail(503, "Deploy disabled");
}

/** Manual deploy of a tag that CI built for the target's component and branch. */
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
  await assertNotDeployLocked(target.environmentId);
  const build = await findBuild(target.componentKey, tag);
  if (!build || build.branch !== target.sourceBranch) {
    fail(404, "Build not found");
  }
  return queuedRun(
    await requestDeployment({
      targetId: target.id,
      tag,
      trigger: "manual",
      userId: session.user.id,
      buildId: build?.id ?? null,
    })
  );
}

/**
 * Deploys the target's previous successful tag again, as a new deployment: the
 * latest successful tag other than the one the server currently runs (which,
 * after a failed deploy, is the last good release).
 */
export async function rollbackTarget(
  targetId: string
): Promise<{ deploymentId: string; runId: string }> {
  const target = await requireTarget(targetId);
  const { session } = await requireProjectPermission(
    { environmentId: target.environmentId },
    { deploy: ["rollback"] }
  );
  requireDeployEnabled();
  await assertNotDeployLocked(target.environmentId);
  const tag = (await getTagState(target.id)).previousTag;
  if (!tag) return fail(409, "No previous successful deploy");
  const build = await findBuild(target.componentKey, tag);
  return queuedRun(
    await requestDeployment({
      targetId: target.id,
      tag,
      trigger: "rollback",
      userId: session.user.id,
      buildId: build?.id ?? null,
    })
  );
}
