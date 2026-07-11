"use server";

import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  getServerSession,
  requireAdmin,
  requireSession,
} from "@/lib/auth-session";
import { db } from "@/lib/db";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { type Environment, environments, projectAccess } from "@/lib/db/schema";
import { loadSafeProject } from "@/lib/projects";
import {
  projectIdSchema,
  projectInputSchema,
  projectUpdateSchema,
} from "@/lib/validation";

type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Environment;
};

/**
 * GET: Fetch all projects (without server details — used for the header
 * picker, sidebar, etc. where only id+name matters).
 */
export async function getProjects(): Promise<Environment[]> {
  const session = await requireSession();
  try {
    // Order by the caller's recency (most-recently-opened first), falling back
    // to name for projects they've never opened. `nulls last` keeps unvisited
    // projects below visited ones instead of Postgres' default nulls-first.
    return await db
      .select(getTableColumns(environments))
      .from(environments)
      .leftJoin(
        projectAccess,
        and(
          eq(projectAccess.projectId, environments.id),
          eq(projectAccess.userId, session.user.id)
        )
      )
      .orderBy(
        sql`${projectAccess.lastAccessedAt} desc nulls last`,
        asc(environments.name)
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
 * Per-user "recently opened" timestamps (epoch ms) keyed by project id, for the
 * projects grid's "Recently opened" sort. Mirrors the header switcher's MRU but
 * as a map the client can sort by. Missing project = never opened by this user.
 */
export async function getProjectsLastOpened(): Promise<Record<string, number>> {
  const session = await getServerSession();
  if (!session) return {};
  try {
    const rows = await db
      .select({
        projectId: projectAccess.projectId,
        lastAccessedAt: projectAccess.lastAccessedAt,
      })
      .from(projectAccess)
      .where(eq(projectAccess.userId, session.user.id));
    const map: Record<string, number> = {};
    for (const r of rows) map[r.projectId] = r.lastAccessedAt.getTime();
    return map;
  } catch (error) {
    console.error("Failed to fetch project open times:", error);
    return {};
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
): Promise<SafeEnvironmentWithServers | undefined> {
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
// URL-friendly base slug from an environment name.
function baseSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "env"
  );
}

// A slug unique within the project — append -2, -3, … on collision.
async function uniqueEnvSlug(projectId: string, name: string): Promise<string> {
  const base = baseSlug(name);
  const existing = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const taken = new Set(existing.map((e) => e.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export async function createProject(data: unknown): Promise<ActionResponse> {
  await requireAdmin();
  const parsed = projectInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const slug = await uniqueEnvSlug(parsed.data.projectId, parsed.data.name);
    const [insertedProject] = await db
      .insert(environments)
      .values({ ...parsed.data, slug })
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
      .update(environments)
      .set(parsed.data)
      .where(eq(environments.id, id))
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
    await db.delete(environments).where(eq(environments.id, id));
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return { success: true, message: "Project deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
