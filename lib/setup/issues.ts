import { DOMAIN_ERRORS } from "@/lib/domains/errors";

// Every code a setup preview can report as an issue, each with a message in
// the `setup.issues` namespace. The server ones come from the rules the setup
// reuses (environment-setup, validateNewEnvironment, the domain, target and
// variable rules, the provisioning plan); tests/setup-draft.test.ts checks
// this list against those tables.

/** Codes the browser raises by itself, before a preview can run. */
export const CLIENT_ISSUE_CODES = ["invalid", "required"] as const;

/** Setup-only refusals (SETUP_ERRORS in server/services/environment-setup). */
export const SETUP_ISSUE_CODES = [
  "appNotFound",
  "serverNotFound",
  "copySourceOtherApp",
  "environmentNameTaken",
  "environmentSlugTaken",
  "backendServiceRequired",
  "serviceNameInUse",
  "backupNeedsSharedDb",
  "invalidInput",
  "targetMissing",
  "sharedDeployDir",
  "passwordVariableMissing",
  "cloudflareUnavailable",
  "forbidden",
] as const;

/** Deploy target rules (TARGET_ERRORS) and the component-in-another-app one. */
export const TARGET_ISSUE_CODES = [
  "componentNotFound",
  "tagVariableIsVariable",
  "targetDuplicate",
  "componentOtherApp",
] as const;

/** Environment placement and binding rules (validateNewEnvironment). */
export const ENVIRONMENT_ISSUE_CODES = [
  "placementForbidden",
  "placementServiceName",
  "placementServiceInUse",
  "placementDatabaseHostContainer",
  "placementDatabaseName",
  "placementDatabaseInUse",
  "databaseHostNotFound",
  "sharedDatabaseNamePrefix",
  "environmentOwnerIneligible",
] as const;

/** Variable rules (VARIABLE_ERRORS). */
export const VARIABLE_ISSUE_CODES = [
  "variableNameInvalid",
  "reservedPrefix",
  "tagVariableName",
  "variableDuplicate",
  "valueInvalid",
  "valueRequired",
  "variableRequired",
  "copySourceRequired",
  "copySourceMissing",
  "copyKindMismatch",
  "escrowCopyForbidden",
  "secretCopyForbidden",
  "copyForbidden",
] as const;

/** Provisioning plan refusals (ProvisioningPlanErrorCode), at field `plan`. */
export const PLAN_ISSUE_CODES = [
  "missing_db_fields",
  "missing_entry_port",
  "no_targets",
] as const;

/**
 * New environment refusals (lib/setup/new-environment, and the unique-index
 * races of its create).
 */
export const NEW_ENVIRONMENT_ISSUE_CODES = [
  "noServerAvailable",
  "repoOtherApp",
  "repoNotBuildable",
  "nameTaken",
  "domainTaken",
  "duplicate",
] as const;

export const SETUP_ISSUE_MESSAGE_CODES: readonly string[] = [
  ...CLIENT_ISSUE_CODES,
  ...NEW_ENVIRONMENT_ISSUE_CODES,
  ...SETUP_ISSUE_CODES,
  ...TARGET_ISSUE_CODES,
  ...ENVIRONMENT_ISSUE_CODES,
  ...(Object.keys(DOMAIN_ERRORS) as (keyof typeof DOMAIN_ERRORS)[]),
  ...VARIABLE_ISSUE_CODES,
  ...PLAN_ISSUE_CODES,
];

const KNOWN = new Set(SETUP_ISSUE_MESSAGE_CODES);

/** Whether the setup messages have a text of the code's own. */
export function isSetupIssueCode(code: string): boolean {
  return KNOWN.has(code);
}

/** The code's message key, or `unknown` for one this list lacks. */
export function issueMessageKey(code: string): string {
  return KNOWN.has(code) ? code : "unknown";
}

/**
 * ICU params of an issue's message: the prefixes the placement rules name
 * (an engineer's names start with the project key).
 */
export function issueParams(projectKey: string): {
  prefix: string;
  dbPrefix: string;
} {
  const key = projectKey.toLowerCase();
  return { prefix: `${key}-`, dbPrefix: `${key}_` };
}

const ACTION_ERROR_CODES: readonly string[] = [
  "environmentOwnerIneligible",
  "placementServiceInUse",
  "placementServiceName",
  "placementDatabaseName",
  "placementDatabaseInUse",
  "placementDatabaseHostContainer",
  "sharedDatabaseNamePrefix",
  "databaseHostNotFound",
];

/**
 * The message path of an issue code: the domain and action-error codes reuse
 * the messages their own screens show; the rest are in `setupWizard.issues`.
 */
export function issueMessagePath(code: string): string {
  if (code in DOMAIN_ERRORS) return `domains.errors.${code}`;
  if (ACTION_ERROR_CODES.includes(code)) return `actionErrors.${code}`;
  return `setupWizard.issues.${issueMessageKey(code)}`;
}
