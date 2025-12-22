"use server";

import { db } from "@/lib/db";
import { projects, type NewProject, type Project } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// Define a standard response type for mutations
type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Project;
};

/**
 * GET: Fetch all projects
 */
export async function getProjects(): Promise<Project[]> {
  try {
    const allProjects = await db.select().from(projects).orderBy(projects.id);
    return allProjects;
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return [];
  }
}

/**
 * GET: Fetch a single project by ID
 */
export async function getProjectById(id: number): Promise<Project | undefined> {
  try {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    return project;
  } catch (error) {
    console.error(`Failed to fetch project ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new project
 */
export async function createProject(data: NewProject): Promise<ActionResponse> {
  try {
    // Insert and return the created object
    const [insertedProject] = await db
      .insert(projects)
      .values(data)
      .returning();

    // Revalidate the projects list page (adjust path as needed)
    revalidatePath("/projects");

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

/**
 * UPDATE: Edit an existing project
 */
export async function updateProject(
  id: number,
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
    revalidatePath(`/projects/${id}`); // Revalidate specific project page if it exists

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

/**
 * DELETE: Remove a project
 */
export async function deleteProject(id: number): Promise<ActionResponse> {
  try {
    await db.delete(projects).where(eq(projects.id, id));

    revalidatePath("/projects");

    return { success: true, message: "Project deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
