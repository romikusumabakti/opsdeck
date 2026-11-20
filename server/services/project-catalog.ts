import { and, asc, eq, isNotNull, notExists } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import {
  ForbiddenError,
  getProjectRole,
  orgGrantAllows,
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
  environmentServices,
  environments,
  environmentVariables,
  type Project,
  projectGroups,
  projectMembers,
  projects,
  releases,
  servers,
} from "@/lib/db/schema";
import { pgErrorCode } from "@/lib/domains/errors";
import { OWNER_COLUMNS } from "@/lib/environments";
import { canCreateProject } from "@/lib/permissions";
import { isProjectReleasable } from "@/lib/releases/repository";
import { holdEnvironmentExclusive } from "@/lib/teardown/guard";
import type { ActionResponse } from "@/lib/types";
import {
  projectMetaInputSchema,
  projectMetaUpdateSchema,
} from "@/lib/validation";
import { CodedHTTPException } from "@/server/errors";
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
): Promise<(ProjectWithEnvironments & { releasable: boolean }) | undefined> {
  await requireSession();
  const row = await db.query.projects.findFirst({
    where: { key: key.toUpperCase() },
    with: WITH_DB_SERVICE,
  });
  if (!row || !(await getProjectRole({ projectId: row.id }))) return undefined;
  return {
    ...(row as unknown as ProjectWithEnvironments),
    ...flattenDbSummary(row as never),
    releasable: await isProjectReleasable(row.id),
  };
}

export async function addProject(
  data: unknown
): Promise<ActionResponse<Project>> {
  const session = await requireSession();
  if (!canCreateProject(session.user.role)) {
    throw new ForbiddenError();
  }
  const parsed = projectMetaInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    // The creator always becomes a member, in the same transaction: it lists
    // them on the project, and it is what makes the project visible to an
    // engineer.
    const created = await db.transaction(async (tx) => {
      const project = one(
        await tx.insert(projects).values(parsed.data).returning(),
        "project"
      );
      await tx
        .insert(projectMembers)
        .values({ projectId: project.id, userId: session.user.id });
      return project;
    });
    // The membership is logged like one added on the Members tab.
    await recordActivity({
      actorId: session.user.id,
      action: "member.added",
      entityType: "member",
      entityId: session.user.id,
      data: { user: session.user.name ?? "?", project: created.name },
    });
    return { success: true, data: created };
  } catch (error) {
    // Unique violation on `key` (pg 23505) → surface a friendly message.
    if (pgErrorCode(error) === "23505") {
      return { success: false, message: "keyTaken" };
    }
    // Foreign-key violation on the group: it does not exist (or was just
    // deleted).
    if (isMissingGroup(error)) await refuseGroupNotFound();
    console.error("Failed to create project:", error);
    return { success: false, message: "Failed to create project" };
  }
}

export async function editProject(
  id: string,
  data: unknown
): Promise<ActionResponse<Project>> {
  const { session } = await requireProjectPermission(
    { projectId: id },
    { environment: ["update"] }
  );
  const parsed = projectMetaUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  // The default server is where engineers may place this project's
  // environments even when it is restricted, so only server:manage sets or
  // clears it.
  if (
    parsed.data.defaultServerId !== undefined &&
    !orgGrantAllows(session, { server: ["manage"] })
  ) {
    const t = await getServerTranslator("actionErrors");
    throw new ForbiddenError(
      t("defaultServerForbidden"),
      "defaultServerForbidden"
    );
  }
  const changesDefaultServer = parsed.data.defaultServerId !== undefined;
  const sendsGroup = parsed.data.groupId !== undefined;
  try {
    const [before] =
      changesDefaultServer || sendsGroup
        ? await db
            .select({
              defaultServerId: projects.defaultServerId,
              groupId: projects.groupId,
            })
            .from(projects)
            .where(eq(projects.id, id))
            .limit(1)
        : [];
    // Anyone who may edit the project assigns it an existing group (managing
    // groups is admin-only); the form may resend the unchanged group.
    const changesGroup =
      sendsGroup && (parsed.data.groupId ?? null) !== (before?.groupId ?? null);
    const [updated] = await db
      .update(projects)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!updated) {
      return { success: false, message: "Project not found" };
    }
    if (
      changesDefaultServer &&
      before?.defaultServerId !== updated.defaultServerId
    ) {
      await recordDefaultServerChange(session.user.id, updated);
    }
    if (changesGroup) await recordGroupChange(session.user.id, updated);
    return { success: true, data: updated };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { success: false, message: "keyTaken" };
    }
    // Foreign-key violation: the group or the default server does not exist.
    if (isMissingGroup(error)) await refuseGroupNotFound();
    if (pgErrorCode(error) === "23503") {
      return { success: false, message: "serverNotFound" };
    }
    console.error(`Failed to update project ${id}:`, error);
    return { success: false, message: "Failed to update project" };
  }
}

async function refuseGroupNotFound(): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(404, "groupNotFound", t("groupNotFound"));
}

// A foreign-key violation on projects.group_id. The constraint name comes
// from postgres.js (drizzle wraps the driver error in `cause`).
function isMissingGroup(error: unknown): boolean {
  const e = error as {
    constraint_name?: string;
    cause?: { constraint_name?: string };
  };
  return (
    pgErrorCode(error) === "23503" &&
    (e?.constraint_name ?? e?.cause?.constraint_name) ===
      "projects_group_id_fkey"
  );
}

/** The activity entry for a project's new group (`group: ""` = none). */
async function recordGroupChange(
  actorId: string,
  project: Project
): Promise<void> {
  const [group] = project.groupId
    ? await db
        .select({ name: projectGroups.name })
        .from(projectGroups)
        .where(eq(projectGroups.id, project.groupId))
        .limit(1)
    : [];
  await recordActivity({
    actorId,
    action: "project.groupChanged",
    entityType: "project",
    entityId: project.id,
    data: { project: project.name, group: group?.name ?? "" },
  });
}

/** The activity entry for a new (or cleared, `server: ""`) default server. */
async function recordDefaultServerChange(
  actorId: string,
  project: Project
): Promise<void> {
  const [server] = project.defaultServerId
    ? await db
        .select({ name: servers.name })
        .from(servers)
        .where(eq(servers.id, project.defaultServerId))
        .limit(1)
    : [];
  await recordActivity({
    actorId,
    action: "project.defaultServerChanged",
    entityType: "project",
    entityId: project.id,
    data: { project: project.name, server: server?.name ?? "" },
  });
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
 * Releases are never cascaded (their files live in Garage, and the foreign
 * key is RESTRICT): while the project has any, the delete is refused (409
 * `projectHasReleases`) for everyone until they are deleted on its Releases
 * page.
 * While any environment of the project records an Assistant read-only
 * database login, the delete is refused (409 `projectHasAssistantDbLogins`)
 * for everyone: the cascade would leave the login on the database server
 * with nothing tracking it. Turning the access off drops it first. The
 * delete holds every environment's lock exclusively (as a Menara-only
 * environment delete does), so an enable in flight finishes first, and its
 * WHERE re-checks for a recorded login.
 */
export async function removeProject(
  id: string,
  {
    confirmEscrowedDeletion = false,
  }: { confirmEscrowedDeletion?: boolean } = {}
): Promise<ActionResponse> {
  const session = await requireOrgPermission({ project: ["delete"] });
  const refuse = async (
    code:
      | "projectHasReleases"
      | "projectHasEscrowedVariables"
      | "projectHasAssistantDbLogins"
  ): Promise<never> => {
    const t = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(409, code, t(code));
  };
  const [release] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(eq(releases.projectId, id))
    .limit(1);
  if (release) await refuse("projectHasReleases");

  const withLogin = () =>
    db
      .select({ id: environmentServices.id })
      .from(environmentServices)
      .innerJoin(
        environments,
        eq(environments.id, environmentServices.environmentId)
      )
      .where(
        and(
          eq(environments.projectId, id),
          isNotNull(environmentServices.assistantDbLogin)
        )
      );
  const [login] = await withLogin().limit(1);
  if (login) await refuse("projectHasAssistantDbLogins");

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
    orgGrantAllows(session, { integration: ["manage"] });
  if (!confirmed && variables.some((v) => v.escrow)) {
    await refuse("projectHasEscrowedVariables");
  }

  const escrowed = () =>
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
      );

  let deleted: { id: string } | undefined;
  try {
    deleted = await db.transaction(async (tx) => {
      // In id order, so two deletes never wait on each other's locks.
      const owned = await tx
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.projectId, id))
        .orderBy(asc(environments.id));
      for (const environment of owned) {
        await holdEnvironmentExclusive(tx, environment.id);
      }
      const [row] = await tx
        .delete(projects)
        .where(
          and(
            eq(projects.id, id),
            notExists(withLogin()),
            confirmed ? undefined : notExists(escrowed())
          )
        )
        .returning({ id: projects.id });
      return row;
    });
  } catch (error) {
    // restrict_violation: a release was made since the check. Releases hold
    // the only ON DELETE RESTRICT foreign key a project delete can reach.
    if (pgErrorCode(error) === "23001") await refuse("projectHasReleases");
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
  // Nothing deleted: a login is recorded, a variable was escrowed since the
  // check, or the project is gone.
  if (!deleted) {
    const [recorded] = await withLogin().limit(1);
    if (recorded) await refuse("projectHasAssistantDbLogins");
    if (!confirmed && variables.length > 0) {
      await refuse("projectHasEscrowedVariables");
    }
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
