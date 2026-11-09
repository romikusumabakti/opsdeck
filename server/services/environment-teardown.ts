import { z } from "zod";
import { requireProjectPermission } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { enqueue } from "@/lib/queue";
import { failRun } from "@/lib/run-progress";
import { TEARDOWN_ERRORS, type TeardownErrorCode } from "@/lib/teardown/errors";
import { buildTeardownPlan } from "@/lib/teardown/plan";
import {
  cancelTeardownSteps,
  environmentBusy,
  latestTeardownRunId,
  listTeardownSteps,
  loadTeardownSubject,
  saveTeardownSteps,
  startTeardownRun,
  teardownState,
} from "@/lib/teardown/repository";
import { CodedHTTPException, notFound } from "@/server/errors";
import { escrowRefusal } from "@/server/services/environments";

// Deleting an environment for good (lib/teardown, lib/jobs/teardown): who
// may, the confirmations, and the refusals that come before any step is
// planned. A refusal is coded (TEARDOWN_ERRORS); the client shows its own
// text for the code.
//
// - Project environment:delete: engineers of the project, and org admins
//   (their implicit engineer role).
// - Production (`kind = 'prod'`): only an org admin (server:manage), who must
//   also send `confirmProduction: true`.
// - Escrowed variables: the guard of the row-only delete
//   (integration:manage + confirmEscrowedDeletion).
// - Busy or running: refused before the plan is built, since saving steps
//   replaces every step that is not done, a running one too.

export const startTeardownSchema = z.object({
  confirmName: z.string().max(200),
  confirmProduction: z.boolean().optional(),
  confirmEscrowedDeletion: z.boolean().optional(),
});
export type StartTeardownInput = z.infer<typeof startTeardownSchema>;

type Status = 403 | 409 | 422;

function refusal(status: Status, code: TeardownErrorCode): never {
  throw new CodedHTTPException(status, code, TEARDOWN_ERRORS[code]);
}

/** Who acts for the teardown, given the environment's kind. */
async function subjectFor(
  environmentId: string,
  orgRole: string | null | undefined
) {
  const subject = (await loadTeardownSubject(environmentId)) ?? notFound();
  const admin = canOrg(orgRole, { server: ["manage"] });
  const production = subject.kind === "prod";
  if (production && !admin) refusal(403, "environmentIsProduction");
  return { subject, production };
}

/** Opens the run and queues the job; a job that cannot be queued closes it. */
async function queueRun(
  environmentId: string,
  userId: string,
  mode: "start" | "retry",
  beforeQueue?: () => Promise<void>
): Promise<{ runId: string }> {
  const started = await startTeardownRun(environmentId, userId, mode);
  if ("refusal" in started) refusal(409, started.refusal);
  try {
    await beforeQueue?.();
    await enqueue("environment/teardown.requested", {
      environmentId,
      runId: started.runId,
    });
  } catch (error) {
    // Without a job the run would stay `started` and refuse every retry.
    await failRun(started.runId, "The teardown could not be started", {
      onlyIfStarted: true,
    });
    throw error;
  }
  return { runId: started.runId };
}

/**
 * Starts a full teardown: checks the confirmations, plans the steps and
 * queues the job. A teardown that already got somewhere (a step is done) is
 * not planned again: the client resumes it with retryTeardown.
 */
export async function startTeardown(
  environmentId: string,
  input: StartTeardownInput
): Promise<{ runId: string }> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { environment: ["delete"] }
  );
  const orgRole = session.user.role;
  const { subject, production } = await subjectFor(environmentId, orgRole);
  if (input.confirmName !== subject.name) {
    refusal(422, "confirmNameMismatch");
  }
  if (production && input.confirmProduction !== true) {
    refusal(422, "productionConfirmRequired");
  }
  const escrowConfirmed =
    input.confirmEscrowedDeletion === true &&
    canOrg(orgRole, { integration: ["manage"] });
  if (subject.hasEscrowedVariables && !escrowConfirmed) {
    throw await escrowRefusal();
  }

  const state = await teardownState(environmentId);
  if (state.running || state.progressed) refusal(409, "teardownRunning");
  if (await environmentBusy(environmentId)) refusal(409, "environmentBusy");

  const plan = (await buildTeardownPlan(environmentId)) ?? notFound();
  if ("refusal" in plan) refusal(409, plan.refusal);
  // The delete step checks escrow again when it runs (a variable may be
  // escrowed meanwhile); it deletes escrowed variables only on this
  // confirmation.
  const steps = escrowConfirmed
    ? plan.steps.map((step) =>
        step.kind === "delete_environment"
          ? { ...step, params: { confirmEscrowedDeletion: true as const } }
          : step
      )
    : plan.steps;
  return queueRun(environmentId, session.user.id, "start", () =>
    saveTeardownSteps(environmentId, steps)
  );
}

/** Resumes a stopped teardown at its first step not done; no re-plan. */
export async function retryTeardown(
  environmentId: string
): Promise<{ runId: string }> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { environment: ["delete"] }
  );
  await subjectFor(environmentId, session.user.role);
  const state = await teardownState(environmentId);
  if (!state.planned) notFound();
  if (state.running) refusal(409, "teardownRunning");
  if (await environmentBusy(environmentId)) refusal(409, "environmentBusy");
  return queueRun(environmentId, session.user.id, "retry");
}

/**
 * Cancels a teardown that has only checked and archived: its steps go, and
 * the environment takes deploys again. A stack an archive_volumes step
 * stopped stays stopped. The open archive is pruned as incomplete later.
 */
export async function cancelTeardown(
  environmentId: string
): Promise<{ cancelled: true }> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { environment: ["delete"] }
  );
  await subjectFor(environmentId, session.user.role);
  const result = await cancelTeardownSteps(environmentId);
  if ("nothing" in result) notFound();
  if ("refusal" in result) refusal(409, result.refusal);
  return { cancelled: true };
}

export type TeardownStatus = {
  runId: string | null;
  steps: { kind: string; status: string; lastError: string | null }[];
} | null;

/** The teardown's steps (no params) and its newest run; null before any. */
export async function getTeardown(
  environmentId: string
): Promise<TeardownStatus> {
  await requireProjectPermission({ environmentId }, { project: ["read"] });
  const steps = await listTeardownSteps(environmentId);
  if (steps.length === 0) return null;
  return {
    runId: await latestTeardownRunId(environmentId),
    steps: steps.map((step) => ({
      kind: step.kind,
      status: step.status,
      lastError: step.lastError,
    })),
  };
}
