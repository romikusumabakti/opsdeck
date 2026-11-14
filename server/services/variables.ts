import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import {
  assertStrongSession,
  requireOrgPermission,
  requireProjectPermission,
} from "@/lib/authz";
import type { DbTransaction } from "@/lib/db";
import {
  type AppVariableTemplate,
  type EnvironmentVariable,
  type VariableKind,
  variableKindEnum,
} from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { encryptSecret } from "@/lib/secrets";
import {
  ESCROW_REMOVAL_MESSAGE,
  ESCROWED_MESSAGE,
  MISSING_REQUIRED_PREFIX,
  NO_APP_MESSAGE,
  NOT_GENERATED_MESSAGE,
  RESERVED_PREFIX_MESSAGE,
  SECRET_TO_PLAIN_MESSAGE,
  SHARED_DEPLOY_DIR_MESSAGE,
} from "@/lib/variables/errors";
import { decodeVariableValue } from "@/lib/variables/managed-env";
import {
  deleteTemplate as deleteTemplateRow,
  deleteVariable as deleteVariableRow,
  type EnvironmentContext,
  getAppIdByKey,
  getEnvironmentContext,
  getVariable,
  hasSharedDeployDir,
  insertVariablesIfMissing,
  listTagVariableNames,
  listTemplates,
  listVariables as listVariableRows,
  replaceGeneratedValue,
  type StoredVariable,
  saveTemplate,
  saveVariable,
  setEnvFileManaged as setEnvFileManagedRow,
  type VariableWrite,
} from "@/lib/variables/repository";
import {
  generateValue,
  hasReservedPrefix,
  type PlaceholderContext,
  resolvePlaceholders,
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";
import { badRequest, CodedHTTPException, notFound } from "@/server/errors";

/**
 * An environment's variables (the managed `.env`) and the app templates they
 * are filled from.
 *
 * Secret and generated values are encrypted at rest (lib/secrets) and leave
 * the server only through `listVariables(…, { reveal: true })`, which records
 * who revealed which names (never the values). Reading and writing need
 * project `variable:read` / `variable:write` — engineers and admins (the
 * environment's owner is a label and gets no rights). Escrowed variables are never regenerated, deleted or
 * changed; only an admin with org `integration:manage` may clear the flag,
 * explicitly. Templates are for `integration:manage`.
 */

export const DEFAULT_GENERATED_LENGTH = 32;
export const GENERATED_LENGTH_MIN = 16;
export const GENERATED_LENGTH_MAX = 128;

const INTEGRATION_MANAGE = { integration: ["manage"] } as const;

const fail = (status: 403 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};

const kindSchema = z.enum(variableKindEnum.enumValues);

export const variableInputSchema = z
  .object({
    kind: kindSchema,
    // Checked by the service (variableValueSchema) so the 400 says why.
    value: z.string().optional(),
    escrow: z.boolean().optional(),
    // With `escrow: false`, clears the escrow flag (admins only).
    confirmEscrowRemoval: z.boolean().optional(),
  })
  .strict();

export const templateInputSchema = z
  .object({
    kind: kindSchema,
    required: z.boolean().default(false),
    // Checked by the service (variableValueSchema) so the 400 says why.
    defaultValue: z.string().nullish(),
    generatedLength: z.number().int().nullish(),
    escrow: z.boolean().default(false),
    description: z.string().trim().max(500).nullish(),
  })
  .strict();

/** A variable as clients see it: secret and generated values masked. */
export type VariableView = {
  name: string;
  kind: VariableKind;
  /** Plain values always; others only when revealed, else null. */
  value: string | null;
  hasValue: boolean;
  escrow: boolean;
  updatedByName: string | null;
  updatedAt: Date;
};

const isPlain = (kind: VariableKind) => kind === "plain";

function encode(kind: VariableKind, value: string): string {
  return isPlain(kind) ? value : encryptSecret(value);
}

function view(row: StoredVariable, reveal: boolean): VariableView {
  return {
    name: row.name,
    kind: row.kind,
    value: isPlain(row.kind) || reveal ? decodeVariableValue(row) : null,
    hasValue: true,
    escrow: row.escrow,
    updatedByName: row.updatedByName,
    updatedAt: row.updatedAt,
  };
}

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    return badRequest(result.error.issues[0]?.message ?? "Invalid request");
  }
  return result.data;
}

/**
 * One activity entry for a change to an environment's variables: the names
 * involved, never a value.
 */
async function audit(
  actorId: string,
  env: EnvironmentContext,
  action: string,
  data: Record<string, string> = {}
): Promise<void> {
  await recordActivity({
    actorId,
    action,
    entityType: "environment",
    entityId: env.id,
    data: { environment: env.name, ...data },
  });
}

async function requireEnvironment(
  environmentId: string
): Promise<EnvironmentContext> {
  return (await getEnvironmentContext(environmentId)) ?? notFound();
}

/** The template of `name` in the environment's app, if any. */
async function templateFor(
  env: EnvironmentContext,
  name: string
): Promise<AppVariableTemplate | undefined> {
  if (!env.appId) return undefined;
  return (await listTemplates(env.appId)).find((t) => t.name === name);
}

/**
 * The required template variables the environment lacks. Tag variables are
 * left out: the deploy writes those itself.
 */
function missingRequired(
  templates: AppVariableTemplate[],
  present: Set<string>,
  tagNames: string[]
): string[] {
  return templates
    .filter(
      (t) => t.required && !present.has(t.name) && !tagNames.includes(t.name)
    )
    .map((t) => t.name)
    .sort();
}

export async function listVariables(
  environmentId: string,
  { reveal = false }: { reveal?: boolean } = {}
): Promise<{
  envFileManaged: boolean;
  hasApp: boolean;
  variables: VariableView[];
}> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["read"] }
  );
  if (reveal) assertStrongSession(session);
  const env = await requireEnvironment(environmentId);
  const rows = await listVariableRows(environmentId);
  if (reveal) {
    await recordActivity({
      actorId: session.user.id,
      action: "variables.revealed",
      entityType: "environment",
      entityId: environmentId,
      data: {
        environment: env.name,
        names: rows
          .filter((row) => !isPlain(row.kind))
          .map((row) => row.name)
          .join(", "),
      },
    });
  }
  return {
    envFileManaged: env.envFileManaged,
    hasApp: env.appId !== null,
    variables: rows.map((row) => view(row, reveal)),
  };
}

/**
 * Creates or updates a variable. Without a value an existing variable keeps
 * its own, and a new generated one is generated now (the template's length,
 * else 32); a new plain or secret one needs a value. Turning a secret or
 * generated variable into a plain one needs an explicit value: keeping the
 * stored one would store and answer the secret in clear without a reveal.
 */
export async function putVariable(
  environmentId: string,
  name: string,
  input: z.infer<typeof variableInputSchema>
): Promise<VariableView> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["write"] }
  );
  const env = await requireEnvironment(environmentId);
  parseOr400(variableNameSchema(await listTagVariableNames(env.id)), name);
  if (input.value !== undefined) parseOr400(variableValueSchema, input.value);

  const existing = await getVariable(env.id, name);
  const template = await templateFor(env, name);

  let escrow = input.escrow ?? existing?.escrow ?? template?.escrow ?? false;
  let escrowRemoved = false;
  if (existing?.escrow) {
    if (input.escrow === false) {
      if (!input.confirmEscrowRemoval) fail(409, ESCROW_REMOVAL_MESSAGE);
      if (!canOrg(session.user.role, INTEGRATION_MANAGE)) {
        fail(403, "Forbidden");
      }
      escrow = false;
      escrowRemoved = true;
    } else if (
      input.kind !== existing.kind ||
      (input.value !== undefined &&
        input.value !== decodeVariableValue(existing))
    ) {
      fail(409, ESCROWED_MESSAGE);
    }
  }

  if (
    existing &&
    !isPlain(existing.kind) &&
    isPlain(input.kind) &&
    input.value === undefined
  ) {
    badRequest(SECRET_TO_PLAIN_MESSAGE);
  }

  let value: string;
  if (input.value !== undefined) value = input.value;
  else if (existing) value = decodeVariableValue(existing);
  else if (input.kind === "generated") {
    value = generateValue(
      template?.generatedLength ?? DEFAULT_GENERATED_LENGTH
    );
  } else return badRequest("Value is required");

  // An escrowed row is only overwritten when it was escrowed when checked
  // above (and the checks passed); one escrowed since then is left alone.
  const written = await saveVariable(
    {
      environmentId: env.id,
      name,
      kind: input.kind,
      value: encode(input.kind, value),
      escrow,
      updatedBy: session.user.id,
    },
    { overwriteEscrowed: existing?.escrow === true }
  );
  if (!written) fail(409, ESCROWED_MESSAGE);
  await audit(
    session.user.id,
    env,
    escrowRemoved
      ? "variable.escrowRemoved"
      : existing
        ? "variable.updated"
        : "variable.created",
    { name }
  );
  return {
    name,
    kind: input.kind,
    value: isPlain(input.kind) ? value : null,
    hasValue: true,
    escrow,
    updatedByName: session.user.name ?? null,
    updatedAt: new Date(),
  };
}

async function requireMutableVariable(
  env: EnvironmentContext,
  name: string
): Promise<EnvironmentVariable> {
  const existing = (await getVariable(env.id, name)) ?? notFound();
  if (existing.escrow) fail(409, ESCROWED_MESSAGE);
  return existing;
}

export async function deleteVariable(
  environmentId: string,
  name: string
): Promise<void> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["write"] }
  );
  const env = await requireEnvironment(environmentId);
  await requireMutableVariable(env, name);
  // The delete re-checks escrow itself: one set since the read is kept.
  if (!(await deleteVariableRow(env.id, name))) fail(409, ESCROWED_MESSAGE);
  await audit(session.user.id, env, "variable.deleted", { name });
}

/** A new random value for a generated variable; the response stays masked. */
export async function regenerateVariable(
  environmentId: string,
  name: string
): Promise<VariableView> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["write"] }
  );
  const env = await requireEnvironment(environmentId);
  const existing = await requireMutableVariable(env, name);
  if (existing.kind !== "generated") fail(409, NOT_GENERATED_MESSAGE);
  const template = await templateFor(env, name);
  const value = generateValue(
    template?.generatedLength ?? DEFAULT_GENERATED_LENGTH
  );
  // Never an upsert: the update re-checks escrow and kind itself, so it can
  // neither recreate a deleted variable nor touch one escrowed since the read.
  const written = await replaceGeneratedValue({
    environmentId: env.id,
    name,
    value: encryptSecret(value),
    updatedBy: session.user.id,
  });
  if (!written) fail(409, ESCROWED_MESSAGE);
  await audit(session.user.id, env, "variable.regenerated", { name });
  return {
    name,
    kind: "generated",
    value: null,
    hasValue: true,
    escrow: false,
    updatedByName: session.user.name ?? null,
    updatedAt: new Date(),
  };
}

/**
 * Adds the app template's variables the environment lacks: plain defaults with
 * their placeholders resolved, generated values generated now. Existing
 * variables are never touched. `missing` lists the required template
 * variables still absent afterwards (no default, a secret, or a placeholder
 * the environment has no value for).
 */
export async function applyTemplate(
  environmentId: string
): Promise<{ added: string[]; missing: string[] }> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["write"] }
  );
  const env = await requireEnvironment(environmentId);
  if (!env.appId) return fail(409, NO_APP_MESSAGE);
  const [templates, rows, tagNames] = await Promise.all([
    listTemplates(env.appId),
    listVariableRows(env.id),
    listTagVariableNames(env.id),
  ]);
  const present = new Set(rows.map((row) => row.name));

  const writes: VariableWrite[] = [];
  for (const template of templates) {
    if (present.has(template.name) || tagNames.includes(template.name)) {
      continue;
    }
    const value = templateValue(template, {
      url: env.url,
      envSlug: env.slug,
    });
    if (value === null) continue;
    writes.push({
      environmentId: env.id,
      name: template.name,
      kind: template.kind,
      value: encode(template.kind, value),
      escrow: template.escrow,
      updatedBy: session.user.id,
    });
  }

  const added = await insertVariablesIfMissing(writes);
  for (const name of added) present.add(name);
  if (added.length > 0) {
    await audit(session.user.id, env, "variables.templateApplied", {
      names: [...added].sort().join(", "),
    });
  }
  return {
    added: added.sort(),
    missing: missingRequired(templates, present, tagNames),
  };
}

/** The value a template gives a new variable, or null when it gives none. */
function templateValue(
  template: AppVariableTemplate,
  placeholders: PlaceholderContext
): string | null {
  if (template.kind === "generated") {
    return generateValue(template.generatedLength ?? DEFAULT_GENERATED_LENGTH);
  }
  if (template.kind !== "plain" || template.defaultValue === null) return null;
  try {
    const value = resolvePlaceholders(template.defaultValue, placeholders);
    return variableValueSchema.safeParse(value).success ? value : null;
  } catch {
    // A placeholder the environment has no value for.
    return null;
  }
}

/**
 * Switches whether deploys render this environment's `.env`. Turning it on
 * needs the deploy dirs to itself (a rendered `.env` replaces the whole file;
 * 409 when another environment deploys into one) and every required template
 * variable to exist (409 listing them). Deploys check the dir again.
 */
export async function setEnvFileManaged(
  environmentId: string,
  enabled: boolean
): Promise<{ envFileManaged: boolean }> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { variable: ["write"], deploy: ["configure"] }
  );
  const env = await requireEnvironment(environmentId);
  if (enabled && (await hasSharedDeployDir(env.id))) {
    fail(409, SHARED_DEPLOY_DIR_MESSAGE);
  }
  if (enabled && env.appId) {
    const [templates, rows, tagNames] = await Promise.all([
      listTemplates(env.appId),
      listVariableRows(env.id),
      listTagVariableNames(env.id),
    ]);
    const missing = missingRequired(
      templates,
      new Set(rows.map((row) => row.name)),
      tagNames
    );
    if (missing.length > 0) {
      fail(409, `${MISSING_REQUIRED_PREFIX}${missing.join(", ")}`);
    }
  }
  await setEnvFileManagedRow(env.id, enabled);
  await audit(
    session.user.id,
    env,
    enabled ? "variables.envFileManagedOn" : "variables.envFileManagedOff"
  );
  return { envFileManaged: enabled };
}

async function requireApp(appKey: string): Promise<string> {
  return (await getAppIdByKey(appKey)) ?? notFound();
}

export async function listVariableTemplates(
  appKey: string
): Promise<AppVariableTemplate[]> {
  await requireOrgPermission({ ...INTEGRATION_MANAGE });
  return listTemplates(await requireApp(appKey));
}

/**
 * A default only on plain templates, a length (16-128) only on generated
 * ones, neither on secrets.
 */
function checkTemplateKind(input: z.infer<typeof templateInputSchema>) {
  const defaultValue = input.defaultValue ?? null;
  const generatedLength = input.generatedLength ?? null;
  if (defaultValue !== null) {
    if (input.kind !== "plain") {
      badRequest("Only plain variables can have a default value");
    }
    parseOr400(variableValueSchema, defaultValue);
    // {host} was retired with the environment host column; the URL carries it.
    if (defaultValue.includes("{host}")) {
      badRequest("Unknown placeholder {host}", "unknownPlaceholder");
    }
  }
  if (generatedLength !== null) {
    if (input.kind !== "generated") {
      badRequest("Only generated variables can have a length");
    }
    if (
      generatedLength < GENERATED_LENGTH_MIN ||
      generatedLength > GENERATED_LENGTH_MAX
    ) {
      badRequest(
        `Length must be from ${GENERATED_LENGTH_MIN} to ${GENERATED_LENGTH_MAX}`
      );
    }
  }
  return { defaultValue, generatedLength };
}

/** Creates the template `name` of the app, or replaces it. */
export async function putVariableTemplate(
  appKey: string,
  name: string,
  input: z.infer<typeof templateInputSchema>
): Promise<AppVariableTemplate> {
  const session = await requireOrgPermission({ ...INTEGRATION_MANAGE });
  const appId = await requireApp(appKey);
  parseOr400(variableNameSchema(), name);
  const { defaultValue, generatedLength } = checkTemplateKind(input);
  const saved = await saveTemplate(appId, {
    name,
    kind: input.kind,
    required: input.required,
    defaultValue,
    generatedLength,
    escrow: input.escrow,
    description: input.description || null,
  });
  await auditTemplate(
    session.user.id,
    "variableTemplate.saved",
    { id: appId, key: appKey },
    name
  );
  return saved;
}

async function auditTemplate(
  actorId: string,
  action: string,
  app: { id: string; key: string },
  name: string
): Promise<void> {
  await recordActivity({
    actorId,
    action,
    entityType: "app",
    entityId: app.id,
    data: { app: app.key, name },
  });
}

export async function deleteVariableTemplate(
  appKey: string,
  name: string
): Promise<void> {
  const session = await requireOrgPermission({ ...INTEGRATION_MANAGE });
  const appId = await requireApp(appKey);
  if (!(await deleteTemplateRow(appId, name))) notFound();
  await auditTemplate(
    session.user.id,
    "variableTemplate.deleted",
    { id: appId, key: appKey },
    name
  );
}

// --- A new environment's variables (the setup wizard) ---

/** One variable the setup wizard asks for. */
export type VariableEntry = {
  name: string;
  kind: VariableKind;
  /** Plain or secret value; a generated one without a value is generated. */
  value?: string;
  /** Take the copy source's value, server-side. */
  copy?: boolean;
};

/** A variable of the environment the setup copies from, as stored. */
export type CopySourceVariable = Pick<
  EnvironmentVariable,
  "name" | "kind" | "value" | "escrow"
>;

/** A variable to insert, its value already in stored form. */
export type PlannedVariable = {
  name: string;
  kind: VariableKind;
  /** Plain text for `plain`, else encrypted (lib/secrets). */
  value: string;
  escrow: boolean;
  origin: "entered" | "generated" | "copied" | "template";
};

/**
 * The refusals of a new environment's variables, by code: the putVariable
 * rules (name, value, a value required), the template's required variables
 * (setEnvFileManaged's 409), and the copy rules. Copied values never leave
 * the server: generated and escrowed ones are never copied, and a secret or
 * plain one only for a caller who may read the source's variables.
 */
export const VARIABLE_ERRORS = {
  variableNameInvalid: [
    400,
    "Variable name must be uppercase letters, digits or '_', not starting with a digit",
  ],
  reservedPrefix: [400, RESERVED_PREFIX_MESSAGE],
  tagVariableName: [400, "Variable name is reserved for the image tag"],
  variableDuplicate: [400, "Variable is listed twice"],
  valueInvalid: [
    400,
    "Value must be a single line, without line breaks or NUL",
  ],
  valueRequired: [400, "Value is required"],
  variableRequired: [409, MISSING_REQUIRED_PREFIX],
  copySourceRequired: [400, "Choose an environment to copy from"],
  copySourceMissing: [400, "The source environment has no such variable"],
  copyKindMismatch: [400, "The source variable is of another kind"],
  escrowCopyForbidden: [
    400,
    "Escrowed variables are never copied: enter a value",
  ],
  secretCopyForbidden: [
    400,
    "You may not read the source's secrets: enter a value",
  ],
  copyForbidden: [
    400,
    "You may not read the source's variables: enter a value",
  ],
} as const satisfies Record<string, readonly [400 | 409, string]>;

export type VariableErrorCode = keyof typeof VARIABLE_ERRORS;

/** The refusal of one variable issue, as a coded HTTP error. */
export function variableIssueError(issue: {
  name: string;
  code: VariableErrorCode;
}): CodedHTTPException {
  const [status, message] = VARIABLE_ERRORS[issue.code];
  return new CodedHTTPException(
    status,
    issue.code,
    issue.code === "variableRequired" ? `${message}${issue.name}` : message
  );
}

function nameIssue(
  name: string,
  tagNames: readonly string[]
): VariableErrorCode | null {
  if (hasReservedPrefix(name)) return "reservedPrefix";
  if (tagNames.includes(name)) return "tagVariableName";
  return variableNameSchema(tagNames).safeParse(name).success
    ? null
    : "variableNameInvalid";
}

/**
 * The variables a new environment starts with: the entries, then the app
 * template's variables they leave out (applyTemplate's rule: plain defaults
 * with placeholders resolved, generated values generated now). Generated
 * values are always new (the template's length, else 32), also for an entry
 * asking to copy one. An escrowed variable (by the template or in the source)
 * stays escrowed and is never copied. Pure apart from encryption and
 * randomness; `issues` holds one entry per refused name, in input order.
 */
export function planEnvironmentVariables({
  entries,
  templates,
  source,
  canReadSource,
  tagNames,
  placeholders,
}: {
  entries: readonly VariableEntry[];
  templates: readonly AppVariableTemplate[];
  /** The copy source's variables; null without a copy source. */
  source: readonly CopySourceVariable[] | null;
  /** Whether the caller may read the source's variables (variable:read). */
  canReadSource: boolean;
  tagNames: readonly string[];
  placeholders: PlaceholderContext;
}): {
  variables: PlannedVariable[];
  issues: { name: string; code: VariableErrorCode }[];
} {
  const variables: PlannedVariable[] = [];
  const issues: { name: string; code: VariableErrorCode }[] = [];
  const seen = new Set<string>();
  const templateOf = (name: string) => templates.find((t) => t.name === name);
  const generatedLength = (name: string) =>
    templateOf(name)?.generatedLength ?? DEFAULT_GENERATED_LENGTH;

  for (const entry of entries) {
    const refuse = (code: VariableErrorCode) =>
      issues.push({ name: entry.name, code });
    const badName = nameIssue(entry.name, tagNames);
    if (badName) {
      refuse(badName);
      continue;
    }
    if (seen.has(entry.name)) {
      refuse("variableDuplicate");
      continue;
    }
    seen.add(entry.name);
    const sourceVariable = source?.find((v) => v.name === entry.name);
    const escrow =
      (templateOf(entry.name)?.escrow ?? false) ||
      (sourceVariable?.escrow ?? false);
    const planned = (value: string, origin: PlannedVariable["origin"]) =>
      variables.push({
        name: entry.name,
        kind: entry.kind,
        value,
        escrow,
        origin,
      });

    if (entry.value !== undefined) {
      if (!variableValueSchema.safeParse(entry.value).success) {
        refuse("valueInvalid");
        continue;
      }
      planned(encode(entry.kind, entry.value), "entered");
    } else if (entry.kind === "generated") {
      planned(
        encryptSecret(generateValue(generatedLength(entry.name))),
        "generated"
      );
    } else if (!entry.copy) {
      refuse("valueRequired");
    } else if (source === null) {
      refuse("copySourceRequired");
    } else if (!sourceVariable) {
      refuse("copySourceMissing");
    } else if (sourceVariable.kind !== entry.kind) {
      // A secret copied as plain would be stored and answered in clear.
      refuse("copyKindMismatch");
    } else if (escrow) {
      refuse("escrowCopyForbidden");
    } else if (!canReadSource) {
      refuse(entry.kind === "secret" ? "secretCopyForbidden" : "copyForbidden");
    } else {
      // Stored form as is: a secret's ciphertext, a plain value's text.
      planned(sourceVariable.value, "copied");
    }
  }

  const named = new Set(entries.map((entry) => entry.name));
  for (const template of templates) {
    if (named.has(template.name) || tagNames.includes(template.name)) continue;
    const value = templateValue(template, placeholders);
    if (value === null) {
      if (template.required) {
        issues.push({ name: template.name, code: "variableRequired" });
      }
      continue;
    }
    variables.push({
      name: template.name,
      kind: template.kind,
      value: encode(template.kind, value),
      escrow: template.escrow,
      origin: "template",
    });
  }
  return { variables, issues };
}

/** Inserts a new environment's planned variables inside the transaction. */
export async function insertVariablesIn(
  tx: DbTransaction,
  environmentId: string,
  variables: readonly PlannedVariable[],
  updatedBy: string
): Promise<void> {
  await insertVariablesIfMissing(
    variables.map((v) => ({
      environmentId,
      name: v.name,
      kind: v.kind,
      value: v.value,
      escrow: v.escrow,
      updatedBy,
    })),
    tx
  );
}
