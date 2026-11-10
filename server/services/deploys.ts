import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { assertTargetMatchesEnvironmentApp, getComponent } from "@/lib/apps";
import { requireProjectPermission } from "@/lib/authz";
import { type DbTransaction, db } from "@/lib/db";
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
  healthTimeoutSchema,
  healthUrlSchema,
  preStartCommandSchema,
  servicesSchema,
  tagVariableSchema,
} from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { tearingDownIn } from "@/lib/teardown/guard";
import { uuidSchema } from "@/lib/validation";
import { getVariable } from "@/lib/variables/repository";
import { CodedHTTPException } from "@/server/errors";
import { assertNotDeployLocked } from "@/server/services/deploy-locks";
import {
  type RequestedDeployment,
  requestDeployment,
} from "@/server/services/deployments";
import { teardownRunningError } from "@/server/services/teardown-runs";

const fail = (status: 404 | 409 | 503, message: string): never => {
  throw new HTTPException(status, { message });
};

// The refusals the setup wizard also reports, by code (server/errors).
export const TARGET_ERRORS = {
  componentNotFound: [404, "Component not found"],
  tagVariableIsVariable: [409, TAG_VARIABLE_IS_VARIABLE_MESSAGE],
  targetDuplicate: [
    409,
    "This component already has a target in the environment",
  ],
} as const satisfies Record<string, readonly [404 | 409, string]>;

export function targetError(
  code: keyof typeof TARGET_ERRORS
): CodedHTTPException {
  const [status, message] = TARGET_ERRORS[code];
  return new CodedHTTPException(status, code, message);
}

function failTarget(code: keyof typeof TARGET_ERRORS): never {
  throw targetError(code);
}

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
    failTarget("tagVariableIsVariable");
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
 * A health URL as the activity log may show it: origin and path only, since
 * userinfo, query and fragment can carry credentials or tokens. Undefined
 * when it does not parse (the entry then says "changed").
 */
function loggableHealthUrl(url: unknown): string | null | undefined {
  if (url === null) return null;
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

/** One `name: old → new` (or `name: changed`) entry for the activity log. */
function describeChange(
  field: keyof TargetChanges,
  before: unknown,
  after: unknown
): string {
  if (!(LOGGED_VALUES as readonly string[]).includes(field)) {
    return `${field}: changed`;
  }
  if (field === "healthUrl") {
    const [from, to] = [loggableHealthUrl(before), loggableHealthUrl(after)];
    if (from === undefined || to === undefined) return `${field}: changed`;
    [before, after] = [from, to];
  }
  return `${field}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`;
}

/**
 * The fields an update really changes, in schema order, and one entry each
 * for the activity log (see describeChange).
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
      describeChange(field, before[field], changes[field])
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
  // Runs after the change is committed: a failed lookup only costs the name.
  const environment = await getEnvironmentForLock(target.environmentId).catch(
    (error: unknown) => {
      console.error("Deploy target audit: environment lookup failed:", error);
      return null;
    }
  );
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
    failTarget("componentNotFound");
  }
  await requireServerInEnvironment(input.environmentId, input.serverId);
  await requireTagVariableFree(input.environmentId, input.tagVariable);
  let created: DeployTarget;
  try {
    created = await db.transaction(async (tx) => {
      // A target added while a teardown runs would never be brought down.
      if (await tearingDownIn(tx, input.environmentId)) {
        throw teardownRunningError();
      }
      return insertDeployTargetIn(tx, input);
    });
  } catch (error) {
    if (isUniqueViolation(error)) return failTarget("targetDuplicate");
    throw error;
  }
  await auditTarget(session.user.id, created, "deployTarget.created");
  return created;
}

/**
 * Inserts a target inside the caller's transaction, after the environment
 * adopts the component's app (409 when it deploys another app). A second
 * target for the component surfaces as a unique violation.
 */
export async function insertDeployTargetIn(
  tx: DbTransaction,
  input: z.infer<typeof createTargetSchema>
): Promise<DeployTarget> {
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
    // A target moved while a teardown runs would leave its stack behind.
    if (await tearingDownIn(tx, target.environmentId)) {
      throw teardownRunningError();
    }
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
  if (requested.status !== "queued") {
    throw new Error(`Deployment was ${requested.status}, not queued`);
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
