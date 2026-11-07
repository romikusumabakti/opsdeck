import { and, asc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  type AppVariableTemplate,
  apps,
  appVariableTemplates,
  databaseHosts,
  deployTargets,
  type EnvironmentVariable,
  environmentServices,
  environments,
  environmentVariables,
  users,
  type VariableKind,
} from "@/lib/db/schema";

// Database access for environment variables and app variable templates.
// Values are stored as given: encrypting and decrypting is the service's job
// (server/services/variables.ts, and lib/variables/managed-env.ts for the
// deploy job), so nothing here ever sees plaintext secrets on purpose.

/** What the variables service needs to know about an environment. */
export type EnvironmentContext = {
  id: string;
  name: string;
  slug: string;
  host: string | null;
  url: string | null;
  appId: string | null;
  envFileManaged: boolean;
};

export async function getEnvironmentContext(
  environmentId: string
): Promise<EnvironmentContext | undefined> {
  const [row] = await db
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      host: environments.host,
      url: environments.url,
      appId: environments.appId,
      envFileManaged: environments.envFileManaged,
    })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row;
}

/**
 * The Docker network of the shared database host the environment's db service
 * is bound to, when that host runs on `serverId` (a network exists only on its
 * own server); null when the binding is not shared, the host has no network
 * recorded, or it is on another server.
 */
export async function getSharedDatabaseNetwork(
  environmentId: string,
  serverId: string
): Promise<string | null> {
  const [row] = await db
    .select({ network: databaseHosts.network })
    .from(environmentServices)
    .innerJoin(
      databaseHosts,
      eq(databaseHosts.id, environmentServices.databaseHostId)
    )
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db"),
        eq(environmentServices.dbKind, "shared"),
        eq(databaseHosts.serverId, serverId)
      )
    )
    .limit(1);
  return row?.network ?? null;
}

/** The tag variable names of the environment's deploy targets, once each. */
export async function listTagVariableNames(
  environmentId: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: deployTargets.tagVariable })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId));
  return rows.map((row) => row.name);
}

/**
 * Whether any deploy target of the environment shares its server and deploy
 * dir with a target of another environment. A managed `.env` replaces the
 * whole file, so such a dir cannot be managed.
 */
export async function hasSharedDeployDir(
  environmentId: string
): Promise<boolean> {
  const other = alias(deployTargets, "other");
  const rows = await db
    .select({ id: deployTargets.id })
    .from(deployTargets)
    .innerJoin(
      other,
      and(
        eq(other.serverId, deployTargets.serverId),
        eq(other.deployDir, deployTargets.deployDir),
        ne(other.environmentId, deployTargets.environmentId)
      )
    )
    .where(eq(deployTargets.environmentId, environmentId))
    .limit(1);
  return rows.length > 0;
}

export type StoredVariable = EnvironmentVariable & {
  updatedByName: string | null;
};

/** The environment's variables by name, with the name of who last wrote each. */
export async function listVariables(
  environmentId: string
): Promise<StoredVariable[]> {
  const rows = await db
    .select({ variable: environmentVariables, updatedByName: users.name })
    .from(environmentVariables)
    .leftJoin(users, eq(users.id, environmentVariables.updatedBy))
    .where(eq(environmentVariables.environmentId, environmentId))
    .orderBy(asc(environmentVariables.name));
  return rows.map((row) => ({
    ...row.variable,
    updatedByName: row.updatedByName,
  }));
}

export async function getVariable(
  environmentId: string,
  name: string
): Promise<EnvironmentVariable | undefined> {
  const [row] = await db
    .select()
    .from(environmentVariables)
    .where(
      and(
        eq(environmentVariables.environmentId, environmentId),
        eq(environmentVariables.name, name)
      )
    )
    .limit(1);
  return row;
}

export type VariableWrite = {
  environmentId: string;
  name: string;
  kind: VariableKind;
  /** Already encrypted unless `kind` is "plain". */
  value: string;
  escrow: boolean;
  updatedBy: string | null;
};

/**
 * Inserts the variable, or replaces its kind, value and escrow flag. Unless
 * `overwriteEscrowed` (the caller already cleared an escrowed row for this
 * write), an existing escrowed row is left alone: the check and the write are
 * one statement, so an escrow set concurrently is never overwritten. Returns
 * whether a row was written.
 */
export async function saveVariable(
  input: VariableWrite,
  { overwriteEscrowed = false }: { overwriteEscrowed?: boolean } = {}
): Promise<boolean> {
  const rows = await db
    .insert(environmentVariables)
    .values(input)
    .onConflictDoUpdate({
      target: [environmentVariables.environmentId, environmentVariables.name],
      set: {
        kind: input.kind,
        value: input.value,
        escrow: input.escrow,
        updatedBy: input.updatedBy,
        updatedAt: sql`now()`,
      },
      setWhere: overwriteEscrowed
        ? undefined
        : eq(environmentVariables.escrow, false),
    })
    .returning({ id: environmentVariables.id });
  return rows.length > 0;
}

/**
 * Replaces the value of an existing, non-escrowed generated variable; never
 * creates one and never touches the escrow flag. Returns whether a row was
 * written (false: gone, escrowed or no longer generated).
 */
export async function replaceGeneratedValue(input: {
  environmentId: string;
  name: string;
  /** Already encrypted. */
  value: string;
  updatedBy: string | null;
}): Promise<boolean> {
  const rows = await db
    .update(environmentVariables)
    .set({
      value: input.value,
      updatedBy: input.updatedBy,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(environmentVariables.environmentId, input.environmentId),
        eq(environmentVariables.name, input.name),
        eq(environmentVariables.escrow, false),
        eq(environmentVariables.kind, "generated")
      )
    )
    .returning({ id: environmentVariables.id });
  return rows.length > 0;
}

/**
 * Deletes a non-escrowed variable. Returns whether a row was deleted (false:
 * gone or escrowed, checked in the same statement).
 */
export async function deleteVariable(
  environmentId: string,
  name: string
): Promise<boolean> {
  const rows = await db
    .delete(environmentVariables)
    .where(
      and(
        eq(environmentVariables.environmentId, environmentId),
        eq(environmentVariables.name, name),
        eq(environmentVariables.escrow, false)
      )
    )
    .returning({ id: environmentVariables.id });
  return rows.length > 0;
}

/**
 * Inserts the variables that don't exist yet, leaving existing ones alone
 * (also against a concurrent writer). Returns the names inserted.
 */
export async function insertVariablesIfMissing(
  rows: VariableWrite[]
): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(environmentVariables)
    .values(rows)
    .onConflictDoNothing({
      target: [environmentVariables.environmentId, environmentVariables.name],
    })
    .returning({ name: environmentVariables.name });
  return inserted.map((row) => row.name);
}

export async function setEnvFileManaged(
  environmentId: string,
  enabled: boolean
): Promise<void> {
  await db
    .update(environments)
    .set({ envFileManaged: enabled })
    .where(eq(environments.id, environmentId));
}

export async function getAppIdByKey(
  appKey: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.appKey, appKey))
    .limit(1);
  return row?.id;
}

export async function listTemplates(
  appId: string
): Promise<AppVariableTemplate[]> {
  return db
    .select()
    .from(appVariableTemplates)
    .where(eq(appVariableTemplates.appId, appId))
    .orderBy(asc(appVariableTemplates.name));
}

export type TemplateWrite = Pick<
  AppVariableTemplate,
  | "name"
  | "kind"
  | "required"
  | "defaultValue"
  | "generatedLength"
  | "escrow"
  | "description"
>;

/** Inserts the template, or replaces every field of the one with its name. */
export async function saveTemplate(
  appId: string,
  input: TemplateWrite
): Promise<AppVariableTemplate> {
  const [row] = await db
    .insert(appVariableTemplates)
    .values({ ...input, appId })
    .onConflictDoUpdate({
      target: [appVariableTemplates.appId, appVariableTemplates.name],
      set: { ...input, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("Template upsert returned no row");
  return row;
}

/** Deletes the template; false when it did not exist. */
export async function deleteTemplate(
  appId: string,
  name: string
): Promise<boolean> {
  const rows = await db
    .delete(appVariableTemplates)
    .where(
      and(
        eq(appVariableTemplates.appId, appId),
        eq(appVariableTemplates.name, name)
      )
    )
    .returning({ id: appVariableTemplates.id });
  return rows.length > 0;
}
