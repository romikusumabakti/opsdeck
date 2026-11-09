// Stable codes of an environment teardown's refusals and step failures. The
// UI shows the translated text of `teardown.errors.<code>` (messages/*); the
// English message here is what the API and the step's `last_error` carry.

export const TEARDOWN_ERRORS = {
  deployDirShared: "Another environment uses this deploy directory",
  domainShared:
    "The Cloudflare Access app or DNS record is shared with another environment or hostname",
  databaseBackupUnsupported:
    "Only PostgreSQL databases can be archived before deletion",
  unsafeDeployDir: "The deploy directory is not a safe path to delete",
  environmentBusy: "A deploy or provisioning run is active on the environment",
  teardownRunning: "The environment is already being deleted",
  databaseNotRegistered:
    "The database service or its database host is missing or incomplete",
  stackHostsSharedDatabase:
    "The stack runs a database container another environment uses",
  serverCommandFailed: "A command on the server failed",
  archiveFailed: "The archive could not be completed",
  cloudflareFailed: "A Cloudflare object could not be removed",
  stepFailed: "The step failed unexpectedly",
  confirmNameMismatch: "The confirmation does not match the environment name",
  environmentIsProduction: "Only an admin can delete a production environment",
  productionConfirmRequired:
    "Deleting a production environment needs an explicit confirmation",
  teardownCannotCancel:
    "The teardown has gone past its archive steps and can only be finished",
  environmentHasEscrowedVariables:
    "The environment has escrowed variables and their deletion was not confirmed by an admin",
} as const;

export type TeardownErrorCode = keyof typeof TEARDOWN_ERRORS;

/** Why buildTeardownPlan, or the API before it, refuses to plan a teardown. */
export type TeardownRefusal = Extract<
  TeardownErrorCode,
  | "deployDirShared"
  | "domainShared"
  | "databaseBackupUnsupported"
  | "unsafeDeployDir"
  | "environmentBusy"
  | "teardownRunning"
>;

/**
 * A teardown step's expected failure: `code` is what the step's `last_error`
 * stores, `message` the English text plus an optional detail for the run log.
 * A detail must already be free of secrets (redactSecrets).
 */
export class StepFailed extends Error {
  constructor(
    readonly code: TeardownErrorCode,
    readonly detail?: string
  ) {
    super(
      detail ? `${TEARDOWN_ERRORS[code]}: ${detail}` : TEARDOWN_ERRORS[code]
    );
    this.name = "StepFailed";
  }
}
