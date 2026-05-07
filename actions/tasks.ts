"use server";

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { type Task, tasks } from "@/lib/db/schema";

export async function getProjectTasks(projectId: string): Promise<Task[]> {
  try {
    return await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.runAt));
  } catch (error) {
    console.error(`Failed to fetch tasks for project ${projectId}:`, error);
    return [];
  }
}
