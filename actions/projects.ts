"use server";

import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  getServerSession,
  requireAdmin,
  requireSession,
} from "@/lib/auth-session";
import { db } from "@/lib/db";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import { type Project, projectAccess, projects } from "@/lib/db/schema";
import { loadSafeProject } from "@/lib/projects";
import {
  projectIdSchema,
  projectInputSchema,
  projectUpdateSchema,
} from "@/lib/validation";

type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Project;
};

/**
 * GET: Fetch all projects (without server details — used for the header
 * picker, sidebar, etc. where only id+name matters).
 */
export async function getProjects(): Promise<Project[]> {
  const session = await requireSession();
  try {
    // Order by the caller's recency (most-recently-opened first), falling back
    // to name for projects they've never opened. `nulls last` keeps unvisited
    // projects below visited ones instead of Postgres' default nulls-first.
    return await db
      .select(getTableColumns(projects))
      .from(projects)
      .leftJoin(
        projectAccess,
        and(
          eq(projectAccess.projectId, projects.id),
          eq(projectAccess.userId, session.user.id)
        )
      )
      .orderBy(
        sql`${projectAccess.lastAccessedAt} desc nulls last`,
        asc(projects.name)
      );
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return [];
  }
}

/**
 * Record that the current user just opened a project, bumping its recency so
 * the header switcher surfaces it first next time. Fire-and-forget: any failure
 * is logged, never thrown, so it can't break a project page render.
 */
export async function recordProjectAccess(projectId: string): Promise<void> {
  const session = await getServerSession();
  if (!session) return;
  try {
    await db
      .insert(projectAccess)
      .values({ userId: session.user.id, projectId })
      .onConflictDoUpdate({
        target: [projectAccess.userId, projectAccess.projectId],
        set: { lastAccessedAt: sql`now()` },
      });
  } catch (error) {
    console.error("Failed to record project access:", error);
  }
}

/**
 * GET: Fetch a single project by ID with its three server relations loaded.
 * Returns a CREDENTIAL-FREE projection — SSH/DB passwords and the mock-time API
 * key are stripped before the data crosses to the client. Actions that need the
 * real credentials re-load them server-side via lib/projects.
 */
export async function getProjectById(
  id: string
): Promise<SafeProjectWithServers | undefined> {
  await requireSession();
  try {
    return (await loadSafeProject(id)) ?? undefined;
  } catch (error) {
    console.error(`Failed to fetch project ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new project. Server FKs (dbServerId, backendServerId,
 * frontendServerId) must already exist — create them via createServer first.
 */
export async function createProject(data: unknown): Promise<ActionResponse> {
  await requireAdmin();
  const parsed = projectInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const [insertedProject] = await db
      .insert(projects)
      .values(parsed.data)
      .returning();

    revalidatePath("/projects");
    revalidatePath("/", "layout");

    return {
      success: true,
      message: "Project created successfully",
      data: insertedProject,
    };
  } catch (error) {
    console.error("Failed to create project:", error);
    return { success: false, message: "Failed to create project" };
  }
}

export async function updateProject(
  id: string,
  data: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  if (!projectIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid project id" };
  }
  const parsed = projectUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const [updatedProject] = await db
      .update(projects)
      .set(parsed.data)
      .where(eq(projects.id, id))
      .returning();

    if (!updatedProject) {
      return { success: false, message: "Project not found" };
    }

    revalidatePath("/projects");
    revalidatePath(`/projects/${id}`);

    return {
      success: true,
      message: "Project updated successfully",
      data: updatedProject,
    };
  } catch (error) {
    console.error(`Failed to update project ${id}:`, error);
    return { success: false, message: "Failed to update project" };
  }
}

export async function deleteProject(id: string): Promise<ActionResponse> {
  await requireAdmin();
  try {
    await db.delete(projects).where(eq(projects.id, id));
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return { success: true, message: "Project deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
