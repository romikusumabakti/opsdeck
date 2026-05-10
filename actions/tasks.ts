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

export type TaskSnapshot = Pick<
  Task,
  | "id"
  | "projectId"
  | "description"
  | "status"
  | "output"
  | "errorMessage"
  | "runAt"
  | "completedAt"
>;

export async function getTaskSnapshot(
  taskId: string
): Promise<TaskSnapshot | null> {
  const row = await db.query.tasks.findFirst({
    where: { id: taskId },
    columns: {
      id: true,
      projectId: true,
      description: true,
      status: true,
      output: true,
      errorMessage: true,
      runAt: true,
      completedAt: true,
    },
  });
  return row ?? null;
}
