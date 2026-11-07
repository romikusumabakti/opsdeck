import { and, asc, eq, notExists } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import {
  getProjectRole,
  projectIdsWhere,
  projectScope,
  requireOrgPermission,
  requireProjectPermission,
} from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type Environment,
  type EnvironmentOwner,
  type EnvironmentSummaryWithOwner,
  environments,
  environmentVariables,
  type Project,
  projects,
} from "@/lib/db/schema";
import { OWNER_COLUMNS } from "@/lib/environments";
import { canOrg } from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import {
  projectMetaInputSchema,
  projectMetaUpdateSchema,
} from "@/lib/validation";
import { getServerTranslator } from "@/server/i18n";

/** All logical projects, name-ordered. Used by the environment-form picker. */
export async function listProjects(): Promise<Project[]> {
  await requireSession();
  try {
    return await db
      .select()
      .from(projects)
      .where(await projectScope(projects.id))
      .orderBy(asc(projects.name));
  } catch (error) {
    console.error("Failed to list projects:", error);
    return [];
  }
}

export type ProjectWithEnvironments = Project & {
  environments: EnvironmentSummaryWithOwner[];
};

// The relational query loads each environment's `db` service so list views get
// the engine + database name inline, plus its owner. Flattening it here keeps
// every consumer on the same `EnvironmentSummaryWithOwner` shape instead of
// walking `services` themselves.
const WITH_DB_SERVICE = {
  environments: {
    with: { services: true, owner: { columns: OWNER_COLUMNS } },
  },
} as const;

type EnvironmentWithServiceRows = Environment & {
  services: { role: string; dbType: unknown; dbName: string | null }[];
  owner: EnvironmentOwner | null;
};

function flattenDbSummary(row: {
  environments: EnvironmentWithServiceRows[];
}): { environments: EnvironmentSummaryWithOwner[] } {
  return {
    ...row,
    environments: row.environments.map(({ services, ...env }) => {
      const dbSvc = services.find((s) => s.role === "db");
      return {
        ...env,
        dbType: (dbSvc?.dbType ??
          null) as EnvironmentSummaryWithOwner["dbType"],
        dbName: dbSvc?.dbName ?? null,
      };
    }),
  };
}

/**
 * Every project with its deployments nested, for the grouped projects grid and
 * the header switcher. Projects with no environments are included (empty array).
 */
export async function listProjectsWithEnvironments(): Promise<
  ProjectWithEnvironments[]
> {
  await requireSession();
  try {
    const rows = await db.query.projects.findMany({
      where: { id: await projectIdsWhere() },
      with: WITH_DB_SERVICE,
      orderBy: { name: "asc" },
    });
    return rows.map((row) => ({
      ...row,
      ...flattenDbSummary(row as never),
    })) as ProjectWithEnvironments[];
  } catch (error) {
    console.error("Failed to list projects with environments:", error);
    return [];
  }
}

export async function getProject(id: string): Promise<Project | undefined> {
  await requireSession();
  if (!(await getProjectRole({ projectId: id }))) return undefined;
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return row;
}

/** A single project with its environments — used by the issues page. */
export async function getProjectWithEnvironments(
  id: string
): Promise<ProjectWithEnvironments | undefined> {
  await requireSession();
  if (!(await getProjectRole({ projectId: id }))) return undefined;
  const row = await db.query.projects.findFirst({
    where: { id },
    with: WITH_DB_SERVICE,
  });
  if (!row) return undefined;
  return {
    ...row,
    ...flattenDbSummary(row as never),
  } as ProjectWithEnvironments;
}

/**
 * Resolve a project by its human `key` (e.g. "CMEM"), with environments — the
 * project-overview page is routed by key for readable, shareable URLs. Key is
 * matched case-insensitively and stored uppercase.
 */
export async function getProjectByKeyWithEnvironments(
  key: string
): Promise<ProjectWithEnvironments | undefined> {
  await requireSession();
  const row = await db.query.projects.findFirst({
    where: { key: key.toUpperCase() },
    with: WITH_DB_SERVICE,
  });
  if (!row || !(await getProjectRole({ projectId: row.id }))) return undefined;
  return {
    ...row,
    ...flattenDbSummary(row as never),
  } as ProjectWithEnvironments;
}

export async function addProject(
  data: unknown
): Promise<ActionResponse<Project>> {
  await requireOrgPermission({ project: ["create"] });
  const parsed = projectMetaInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const created = one(
      await db.insert(projects).values(parsed.data).returning(),
      "project"
    );
    return { success: true, data: created };
  } catch (error) {
    // Unique violation on `key` (pg 23505) → surface a friendly message.
    if ((error as { code?: string })?.code === "23505") {
      return { success: false, message: "keyTaken" };
    }
    console.error("Failed to create project:", error);
    return { success: false, message: "Failed to create project" };
  }
}

export async function editProject(
  id: string,
  data: unknown
): Promise<ActionResponse<Project>> {
  await requireProjectPermission(
    { projectId: id },
    { environment: ["update"] }
  );
  const parsed = projectMetaUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const [updated] = await db
      .update(projects)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!updated) {
      return { success: false, message: "Project not found" };
    }
    return { success: true, data: updated };
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      return { success: false, message: "keyTaken" };
    }
    console.error(`Failed to update project ${id}:`, error);
    return { success: false, message: "Failed to update project" };
  }
}

/**
 * Delete a project. Cascades to its environments (their runs and variables)
 * and to its issues — the caller must confirm this destructive action first.
 * Escrowed variables exist nowhere else, so while any environment of the
 * project has one the delete is refused (409) unless an admin with org
 * integration:manage passes `confirmEscrowedDeletion`. The delete itself
 * re-checks escrow, so a variable escrowed after the check still blocks it.
 * Each environment that loses variables is recorded in the activity feed with
 * their names and count, never their values.
 */
export async function removeProject(
  id: string,
  {
    confirmEscrowedDeletion = false,
  }: { confirmEscrowedDeletion?: boolean } = {}
): Promise<ActionResponse> {
  const session = await requireOrgPermission({ project: ["delete"] });
  const variables = await db
    .select({
      environmentId: environments.id,
      environment: environments.name,
      name: environmentVariables.name,
      escrow: environmentVariables.escrow,
    })
    .from(environmentVariables)
    .innerJoin(
      environments,
      eq(environments.id, environmentVariables.environmentId)
    )
    .where(eq(environments.projectId, id))
    .orderBy(asc(environments.name), asc(environmentVariables.name));
  const confirmed =
    confirmEscrowedDeletion &&
    canOrg(session.user.role, { integration: ["manage"] });
  const refuseEscrowed = async (): Promise<never> => {
    const t = await getServerTranslator("actionErrors");
    throw new HTTPException(409, { message: t("projectHasEscrowedVariables") });
  };
  if (!confirmed && variables.some((v) => v.escrow)) await refuseEscrowed();

  let deleted: { id: string } | undefined;
  try {
    [deleted] = await db
      .delete(projects)
      .where(
        confirmed
          ? eq(projects.id, id)
          : and(
              eq(projects.id, id),
              notExists(
                db
                  .select({ id: environmentVariables.id })
                  .from(environmentVariables)
                  .innerJoin(
                    environments,
                    eq(environments.id, environmentVariables.environmentId)
                  )
                  .where(
                    and(
                      eq(environments.projectId, id),
                      eq(environmentVariables.escrow, true)
                    )
                  )
              )
            )
      )
      .returning({ id: projects.id });
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
  // Nothing deleted: either a variable was escrowed since the check, or the
  // project is gone.
  if (!deleted) {
    if (!confirmed && variables.length > 0) await refuseEscrowed();
    return { success: false, message: "Project not found" };
  }
  const byEnvironment = new Map<
    string,
    { environment: string; names: string[] }
  >();
  for (const v of variables) {
    const entry = byEnvironment.get(v.environmentId) ?? {
      environment: v.environment,
      names: [],
    };
    entry.names.push(v.name);
    byEnvironment.set(v.environmentId, entry);
  }
  for (const [environmentId, { environment, names }] of byEnvironment) {
    await recordActivity({
      actorId: session.user.id,
      action: "environment.deletedWithVariables",
      entityType: "environment",
      entityId: environmentId,
      data: { environment, count: names.length, names: names.join(", ") },
    });
  }
  return { success: true };
}
