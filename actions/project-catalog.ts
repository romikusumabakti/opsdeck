"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type Environment,
  type EnvironmentSummary,
  type Project,
  projects,
} from "@/lib/db/schema";
import {
  projectMetaInputSchema,
  projectMetaUpdateSchema,
} from "@/lib/validation";

type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Project;
};

/** All logical projects, name-ordered. Used by the environment-form picker. */
export async function listProjects(): Promise<Project[]> {
  await requireSession();
  try {
    return await db.select().from(projects).orderBy(asc(projects.name));
  } catch (error) {
    console.error("Failed to list projects:", error);
    return [];
  }
}

export type ProjectWithEnvironments = Project & {
  environments: EnvironmentSummary[];
};

// The relational query loads each environment's `db` service so list views get
// the engine + database name inline. Flattening it here keeps every consumer on
// the same `EnvironmentSummary` shape instead of walking `services` themselves.
const WITH_DB_SERVICE = {
  environments: { with: { services: true } },
} as const;

type EnvironmentWithServiceRows = Environment & {
  services: { role: string; dbType: unknown; dbName: string | null }[];
};

function flattenDbSummary(row: {
  environments: EnvironmentWithServiceRows[];
}): { environments: EnvironmentSummary[] } {
  return {
    ...row,
    environments: row.environments.map(({ services, ...env }) => {
      const dbSvc = services.find((s) => s.role === "db");
      return {
        ...env,
        dbType: (dbSvc?.dbType ?? null) as EnvironmentSummary["dbType"],
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
  if (!row) return undefined;
  return {
    ...row,
    ...flattenDbSummary(row as never),
  } as ProjectWithEnvironments;
}

export async function addProject(data: unknown): Promise<ActionResponse> {
  await requireAdmin();
  const parsed = projectMetaInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const [created] = await db.insert(projects).values(parsed.data).returning();
    revalidatePath("/projects");
    revalidatePath("/", "layout");
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
): Promise<ActionResponse> {
  await requireAdmin();
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
    revalidatePath("/projects");
    revalidatePath("/", "layout");
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
 * Delete a project. Cascades to its environments (and their runs) and to its
 * issues — the caller must confirm this destructive action first.
 */
export async function removeProject(id: string): Promise<ActionResponse> {
  await requireAdmin();
  try {
    await db.delete(projects).where(eq(projects.id, id));
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
