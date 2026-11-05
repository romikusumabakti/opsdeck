import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission, requireProjectPermission } from "@/lib/authz";
import {
  type AppVariableTemplate,
  type EnvironmentVariable,
  type VariableKind,
  variableKindEnum,
} from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  ESCROW_REMOVAL_MESSAGE,
  ESCROWED_MESSAGE,
  MISSING_REQUIRED_PREFIX,
  NO_APP_MESSAGE,
  NOT_GENERATED_MESSAGE,
} from "@/lib/variables/errors";
import {
  deleteTemplate as deleteTemplateRow,
  deleteVariable as deleteVariableRow,
  type EnvironmentContext,
  getAppIdByKey,
  getEnvironmentContext,
  getVariable,
  insertVariablesIfMissing,
  listTagVariableNames,
  listTemplates,
  listVariables as listVariableRows,
  type StoredVariable,
  saveTemplate,
  saveVariable,
  setEnvFileManaged as setEnvFileManagedRow,
  type VariableWrite,
} from "@/lib/variables/repository";
import {
  generateValue,
  resolvePlaceholders,
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";
import { badRequest, notFound } from "@/server/errors";

/**
 * An environment's variables (the managed `.env`) and the app templates they
 * are filled from.
 *
 * Secret and generated values are encrypted at rest (lib/secrets) and leave
 * the server only through `listVariables(…, { reveal: true })`, which records
 * who revealed which names (never the values). Reading and writing need
 * project `variable:read` / `variable:write` — maintainers, admins and the
 * environment's owner. Escrowed variables are never regenerated, deleted or
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

function decode(row: Pick<EnvironmentVariable, "kind" | "value">): string {
  return isPlain(row.kind) ? row.value : decryptSecret(row.value);
}

function view(row: StoredVariable, reveal: boolean): VariableView {
  return {
    name: row.name,
    kind: row.kind,
    value: isPlain(row.kind) || reveal ? decode(row) : null,
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
 * else 32); a new plain or secret one needs a value.
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
  if (existing?.escrow) {
    if (input.escrow === false) {
      if (!input.confirmEscrowRemoval) fail(409, ESCROW_REMOVAL_MESSAGE);
      if (!canOrg(session.user.role, INTEGRATION_MANAGE)) {
        fail(403, "Forbidden");
      }
      escrow = false;
    } else if (
      input.kind !== existing.kind ||
      (input.value !== undefined && input.value !== decode(existing))
    ) {
      fail(409, ESCROWED_MESSAGE);
    }
  }

  let value: string;
  if (input.value !== undefined) value = input.value;
  else if (existing) value = decode(existing);
  else if (input.kind === "generated") {
    value = generateValue(
      template?.generatedLength ?? DEFAULT_GENERATED_LENGTH
    );
  } else return badRequest("Value is required");

  await saveVariable({
    environmentId: env.id,
    name,
    kind: input.kind,
    value: encode(input.kind, value),
    escrow,
    updatedBy: session.user.id,
  });
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
  await requireProjectPermission({ environmentId }, { variable: ["write"] });
  const env = await requireEnvironment(environmentId);
  await requireMutableVariable(env, name);
  await deleteVariableRow(env.id, name);
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
  await saveVariable({
    environmentId: env.id,
    name,
    kind: "generated",
    value: encryptSecret(value),
    escrow: false,
    updatedBy: session.user.id,
  });
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
    const value = templateValue(template, env);
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
  return {
    added: added.sort(),
    missing: missingRequired(templates, present, tagNames),
  };
}

/** The value a template gives a new variable, or null when it gives none. */
function templateValue(
  template: AppVariableTemplate,
  env: EnvironmentContext
): string | null {
  if (template.kind === "generated") {
    return generateValue(template.generatedLength ?? DEFAULT_GENERATED_LENGTH);
  }
  if (template.kind !== "plain" || template.defaultValue === null) return null;
  try {
    const value = resolvePlaceholders(template.defaultValue, {
      host: env.host,
      url: env.url,
      envSlug: env.slug,
    });
    return variableValueSchema.safeParse(value).success ? value : null;
  } catch {
    // A placeholder the environment has no value for.
    return null;
  }
}

/**
 * Switches whether deploys render this environment's `.env`. Turning it on
 * needs every required template variable to exist (409 listing them).
 */
export async function setEnvFileManaged(
  environmentId: string,
  enabled: boolean
): Promise<{ envFileManaged: boolean }> {
  await requireProjectPermission(
    { environmentId },
    { variable: ["write"], deploy: ["configure"] }
  );
  const env = await requireEnvironment(environmentId);
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
  await requireOrgPermission({ ...INTEGRATION_MANAGE });
  const appId = await requireApp(appKey);
  parseOr400(variableNameSchema(), name);
  const { defaultValue, generatedLength } = checkTemplateKind(input);
  return saveTemplate(appId, {
    name,
    kind: input.kind,
    required: input.required,
    defaultValue,
    generatedLength,
    escrow: input.escrow,
    description: input.description || null,
  });
}

export async function deleteVariableTemplate(
  appKey: string,
  name: string
): Promise<void> {
  await requireOrgPermission({ ...INTEGRATION_MANAGE });
  const appId = await requireApp(appKey);
  if (!(await deleteTemplateRow(appId, name))) notFound();
}
