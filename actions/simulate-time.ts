"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type ProjectWithServers, tasks } from "@/lib/db/schema";
import { createTask } from "@/lib/task-progress";

type SimulateTimeResult =
  | { success: true; mode: "api" }
  | { success: true; mode: "legacy"; taskId: string }
  | { success: false; mode: "api" | "legacy"; error: string };

const API_TIMEOUT_MS = 5000;

// Node's fetch retries every resolved address (Happy Eyeballs). When all fail
// it surfaces an AggregateError under `cause` whose `errors[]` each carry the
// real reason (ETIMEDOUT, ECONNREFUSED, ENETUNREACH...). Pull the most useful
// one for the toast.
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const errors = (
        cause as { errors?: Array<{ code?: string; message?: string }> }
      ).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        return first.code
          ? `${first.code}: ${first.message ?? ""}`
          : (first.message ?? err.message);
      }
      const code = (cause as { code?: string }).code;
      if (code) return code;
    }
    return err.message || err.name;
  }
  return String(err);
}

export async function simulateProjectTime(
  project: ProjectWithServers,
  simulatedAt: string
): Promise<SimulateTimeResult> {
  const session = await requireSession();
  const apiUrl = project.backendSimulateTimeApiUrl?.trim();

  if (apiUrl) {
    const runAt = new Date();
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulatedAt }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          success: false,
          mode: "api",
          error: `${response.status} ${response.statusText}`,
        };
      }
      // API mode is sync (a single POST), so we record the completed task
      // directly instead of going through the live-progress flow.
      await db.insert(tasks).values({
        projectId: project.id,
        userId: session.user.id,
        description: `Simulate time to ${simulatedAt}`,
        status: "success",
        runAt,
        completedAt: new Date(),
      });
      return { success: true, mode: "api" };
    } catch (error) {
      return { success: false, mode: "api", error: describeFetchError(error) };
    }
  }

  try {
    const taskId = await createTask({
      projectId: project.id,
      userId: session.user.id,
      description: `Simulate time to ${simulatedAt} (legacy)`,
    });
    await inngest.send({
      name: "project/simulate-time.legacy",
      data: { project, simulatedAt, taskId },
    });
    return { success: true, mode: "legacy", taskId };
  } catch (error) {
    return { success: false, mode: "legacy", error: describeFetchError(error) };
  }
}
