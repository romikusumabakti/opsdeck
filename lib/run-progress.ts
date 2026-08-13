import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { environments, type NewRun, projects, runs } from "@/lib/db/schema";
import { notifyRunFailed } from "@/lib/notifications";

export type CreateRunInput = Omit<
  NewRun,
  "id" | "status" | "output" | "errorMessage" | "completedAt" | "runAt"
> & { runAt?: Date };

export async function createRun(input: CreateRunInput): Promise<string> {
  const row = one(
    await db
      .insert(runs)
      .values({
        ...input,
        runAt: input.runAt ?? new Date(),
        status: "started",
        output: "",
      })
      .returning({ id: runs.id }),
    "run"
  );
  return row.id;
}

// Hard cap on stored run output. Bounds the row size and, more importantly,
// the per-poll serialization cost in the SSE stream (which re-reads the whole
// blob each tick — unbounded growth makes that O(n²) over a run's life).
const MAX_OUTPUT_CHARS = 262144; // ~256 KB

export async function appendRunOutput(
  runId: string,
  line: string
): Promise<void> {
  const ts = new Date().toISOString();
  const formatted = `[${ts}] ${line}\n`;
  // Keep the tail (most recent lines). `right` counts characters, so it's
  // multibyte-safe; it may clip the oldest retained line, which is acceptable
  // for a scrolling log.
  await db
    .update(runs)
    .set({
      output: sql`right(${runs.output} || ${formatted}, ${MAX_OUTPUT_CHARS})`,
    })
    .where(eq(runs.id, runId));
}

export async function completeRun(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "success", completedAt: new Date() })
    .where(eq(runs.id, runId));
}

export async function failRun(
  runId: string,
  errorMessage: string
): Promise<void> {
  await db
    .update(runs)
    .set({
      status: "failed",
      errorMessage,
      completedAt: new Date(),
    })
    .where(eq(runs.id, runId));

  // Best-effort: notify the initiator that their job failed. Never let a
  // notification error mask the original failure.
  try {
    const [run] = await db
      .select({
        userId: runs.userId,
        environmentId: runs.environmentId,
        description: runs.description,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (run?.userId) {
      // The notification links to the environment's readable URL, so pull the
      // owning project's key alongside the env slug in one join.
      const [env] = await db
        .select({
          name: environments.name,
          slug: environments.slug,
          projectKey: projects.key,
        })
        .from(environments)
        .innerJoin(projects, eq(projects.id, environments.projectId))
        .where(eq(environments.id, run.environmentId))
        .limit(1);
      if (env) {
        await notifyRunFailed({
          userId: run.userId,
          projectKey: env.projectKey,
          envSlug: env.slug,
          environmentName: env.name,
          description: run.description,
        });
      }
    }
  } catch (error) {
    console.error("Failed to emit run-failed notification:", error);
  }
}
