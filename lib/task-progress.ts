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

// Hard cap on stored task output. Bounds the row size and, more importantly,
// the per-poll serialization cost in the SSE stream (which re-reads the whole
// blob each tick — unbounded growth makes that O(n²) over a task's life).
const MAX_OUTPUT_CHARS = 262144; // ~256 KB

export async function appendTaskOutput(
  taskId: string,
  line: string
): Promise<void> {
  const ts = new Date().toISOString();
  const formatted = `[${ts}] ${line}\n`;
  // Keep the tail (most recent lines). `right` counts characters, so it's
  // multibyte-safe; it may clip the oldest retained line, which is acceptable
  // for a scrolling log.
  await db
    .update(tasks)
    .set({
      output: sql`right(${tasks.output} || ${formatted}, ${MAX_OUTPUT_CHARS})`,
    })
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
