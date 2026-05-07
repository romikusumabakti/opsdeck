"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  type NewProject,
  type Project,
  type ProjectWithServers,
  projects,
} from "@/lib/db/schema";

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
  try {
    return await db.select().from(projects).orderBy(projects.id);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return [];
  }
}

/**
 * GET: Fetch a single project by ID with its three server relations loaded.
 */
export async function getProjectById(
  id: string
): Promise<ProjectWithServers | undefined> {
  try {
    const project = await db.query.projects.findFirst({
      where: { id },
      with: {
        dbServer: true,
        backendServer: true,
        frontendServer: true,
      },
    });
    return project as ProjectWithServers | undefined;
  } catch (error) {
    console.error(`Failed to fetch project ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new project. Server FKs (dbServerId, backendServerId,
 * frontendServerId) must already exist — create them via createServer first.
 */
export async function createProject(data: NewProject): Promise<ActionResponse> {
  try {
    const [insertedProject] = await db
      .insert(projects)
      .values(data)
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
  data: Partial<NewProject>
): Promise<ActionResponse> {
  try {
    const [updatedProject] = await db
      .update(projects)
      .set(data)
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
  try {
    await db.delete(projects).where(eq(projects.id, id));
    revalidatePath("/projects");
    return { success: true, message: "Project deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
