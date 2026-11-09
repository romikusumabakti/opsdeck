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
  databaseNotRegistered: "The database service is not registered",
  archiveFailed: "The archive could not be completed",
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
