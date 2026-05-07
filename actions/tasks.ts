"use server";

import { db } from "@/lib/db";
import type { Task } from "@/lib/db/schema";

export type TaskWithUser = Task & {
  user: { id: string; name: string; email: string } | null;
};

export async function getProjectTasks(
  projectId: string
): Promise<TaskWithUser[]> {
  try {
    const rows = await db.query.tasks.findMany({
      where: { projectId },
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: { runAt: "desc" },
    });
    return rows as TaskWithUser[];
  } catch (error) {
    console.error(`Failed to fetch tasks for project ${projectId}:`, error);
    return [];
  }
}
