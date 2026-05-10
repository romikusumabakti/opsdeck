import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type NewTask, tasks } from "@/lib/db/schema";

export type CreateTaskInput = Omit<
  NewTask,
  "id" | "status" | "output" | "errorMessage" | "completedAt" | "runAt"
> & { runAt?: Date };

export async function createTask(input: CreateTaskInput): Promise<string> {
  const [row] = await db
    .insert(tasks)
    .values({
      ...input,
      runAt: input.runAt ?? new Date(),
      status: "started",
      output: "",
    })
    .returning({ id: tasks.id });
  return row.id;
}

export async function appendTaskOutput(
  taskId: string,
  line: string
): Promise<void> {
  const ts = new Date().toISOString();
  const formatted = `[${ts}] ${line}\n`;
  await db
    .update(tasks)
    .set({ output: sql`${tasks.output} || ${formatted}` })
    .where(eq(tasks.id, taskId));
}

export async function completeTask(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "success", completedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function failTask(
  taskId: string,
  errorMessage: string
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: "failed",
      errorMessage,
      completedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}
