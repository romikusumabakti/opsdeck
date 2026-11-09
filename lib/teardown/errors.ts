// Stable codes of an environment teardown's refusals and step failures. The
// UI shows the translated text of `teardown.errors.<code>` (messages/*); the
// English message here is what the API and the step's `last_error` carry.

export const TEARDOWN_ERRORS = {
  deployDirShared: "Another environment uses this deploy directory",
  domainShared:
    "Another environment records the same Cloudflare Access app or DNS record",
  databaseBackupUnsupported:
    "Only PostgreSQL databases can be archived before deletion",
  unsafeDeployDir: "The deploy directory is not a safe path to delete",
  environmentBusy: "A deploy or provisioning run is active on the environment",
  teardownRunning: "The environment is already being deleted",
  databaseNotRegistered:
    "The stack's data is not covered by a registered database service",
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
