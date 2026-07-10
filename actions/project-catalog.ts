"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type Environment,
  environments,
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
  environments: Environment[];
};

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
      with: { environments: true },
      orderBy: { name: "asc" },
    });
    return rows as ProjectWithEnvironments[];
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
    with: { environments: true },
  });
  return row as ProjectWithEnvironments | undefined;
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
