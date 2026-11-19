import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DbExecutor, type DbTransaction, db } from "@/lib/db";
import {
  appComponents,
  databaseHosts,
  deployTargets,
  type EnvironmentVariable,
  environmentServices,
  environments,
  environmentVariables,
  type ServiceVariableTemplate,
  serviceVariableTemplates,
  users,
  type VariableKind,
} from "@/lib/db/schema";

// Database access for environment variables and service variable templates.
// Values are stored as given: encrypting and decrypting is the service's job
// (server/services/variables.ts, and lib/variables/managed-env.ts for the
// deploy job), so nothing here ever sees plaintext secrets on purpose.

/** What the variables service needs to know about an environment. */
export type EnvironmentContext = {
  id: string;
  name: string;
  slug: string;
  /** The slug it was created with; null for rows seeded without it. */
  createdSlug: string | null;
  url: string | null;
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
      createdSlug: environments.createdSlug,
      url: environments.url,
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
 * Whether a deploy target of any environment deploys into the dir on the
 * server (a new environment's dir must be its own: its `.env` is managed).
 */
export async function deployDirInUse(
  serverId: string,
  deployDir: string
): Promise<boolean> {
  const rows = await db
    .select({ id: deployTargets.id })
    .from(deployTargets)
    .where(
      and(
        eq(deployTargets.serverId, serverId),
        eq(deployTargets.deployDir, deployDir)
      )
    )
    .limit(1);
  return rows.length > 0;
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
 * Inserts the variables or replaces their kind, value and escrow flag, in one
 * statement inside the caller's transaction (an import). An existing escrowed
 * row is never replaced, also against a concurrent writer: it is left out of
 * the result, and the caller rolls the transaction back. Returns the names
 * written, each with whether it replaced a stored row.
 */
export async function importVariables(
  tx: DbTransaction,
  writes: readonly VariableWrite[]
): Promise<{ name: string; overwritten: boolean }[]> {
  if (writes.length === 0) return [];
  return (
    tx
      .insert(environmentVariables)
      .values([...writes])
      .onConflictDoUpdate({
        target: [environmentVariables.environmentId, environmentVariables.name],
        set: {
          kind: sql`excluded.kind`,
          value: sql`excluded.value`,
          escrow: sql`excluded.escrow`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`now()`,
        },
        setWhere: eq(environmentVariables.escrow, false),
      })
      // xmax is 0 for a row this statement inserted, else the updating
      // transaction's id (the documented upsert idiom).
      .returning({
        name: environmentVariables.name,
        overwritten: sql<boolean>`(xmax <> 0)`,
      })
  );
}

/**
 * Inserts the variables that don't exist yet, leaving existing ones alone
 * (also against a concurrent writer). Returns the names inserted.
 */
export async function insertVariablesIfMissing(
  rows: VariableWrite[],
  executor: DbExecutor = db
): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await executor
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

/** The services the environment's deploy targets deploy, sorted. */
export async function listEnvironmentServiceKeys(
  environmentId: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ componentKey: deployTargets.componentKey })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.componentKey));
  return rows.map((row) => row.componentKey);
}

export async function serviceKeyExists(componentKey: string): Promise<boolean> {
  const rows = await db
    .select({ componentKey: appComponents.componentKey })
    .from(appComponents)
    .where(eq(appComponents.componentKey, componentKey))
    .limit(1);
  return rows.length > 0;
}

/** The templates of the given services, by name then service. */
export async function listServiceTemplates(
  componentKeys: readonly string[]
): Promise<ServiceVariableTemplate[]> {
  if (componentKeys.length === 0) return [];
  return db
    .select()
    .from(serviceVariableTemplates)
    .where(inArray(serviceVariableTemplates.componentKey, [...componentKeys]))
    .orderBy(
      asc(serviceVariableTemplates.name),
      asc(serviceVariableTemplates.componentKey)
    );
}

export type TemplateWrite = Pick<
  ServiceVariableTemplate,
  | "name"
  | "kind"
  | "required"
  | "defaultValue"
  | "generatedLength"
  | "escrow"
  | "description"
>;

/** Inserts the service's template, or replaces every field of the one with its name. */
export async function saveTemplate(
  componentKey: string,
  input: TemplateWrite
): Promise<ServiceVariableTemplate> {
  const [row] = await db
    .insert(serviceVariableTemplates)
    .values({ ...input, componentKey })
    .onConflictDoUpdate({
      target: [
        serviceVariableTemplates.componentKey,
        serviceVariableTemplates.name,
      ],
      set: { ...input, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("Template upsert returned no row");
  return row;
}

/** Deletes the service's template; false when it did not exist. */
export async function deleteTemplate(
  componentKey: string,
  name: string
): Promise<boolean> {
  const rows = await db
    .delete(serviceVariableTemplates)
    .where(
      and(
        eq(serviceVariableTemplates.componentKey, componentKey),
        eq(serviceVariableTemplates.name, name)
      )
    )
    .returning({ id: serviceVariableTemplates.id });
  return rows.length > 0;
}
