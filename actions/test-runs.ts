"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import { testRunSchema } from "@/lib/validation";

export type TestRunRow = {
  id: string;
  status: string;
  description: string;
  runAt: Date;
};

/** Test-run results recorded against an issue, newest first. */
export async function listIssueTestRuns(
  issueId: string
): Promise<TestRunRow[]> {
  await requireSession();
  try {
    return await db
      .select({
        id: runs.id,
        status: runs.status,
        description: runs.description,
        runAt: runs.runAt,
      })
      .from(runs)
      .where(and(eq(runs.issueId, issueId), eq(runs.kind, "test")))
      .orderBy(desc(runs.runAt));
  } catch (error) {
    console.error("Failed to list issue test runs:", error);
    return [];
  }
}

/**
 * Record a QA test result for an issue. A test run acts on an environment (runs
 * are environment-scoped), so the issue must be pinned to one — QA reproduces
 * the bug in a specific deployment. The record is a completed run (kind=test,
 * status pass/fail) linked back to the issue.
 */
export async function recordTestRun(
  data: unknown
): Promise<{ success: boolean; message?: string }> {
  const session = await requireSession();
  const parsed = testRunSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid test data" };
  }
  const input = parsed.data;

  const issue = await db.query.issues.findFirst({
    where: { id: input.issueId },
    columns: { environmentId: true, number: true },
  });
  if (!issue) return { success: false, message: "Issue not found" };
  if (!issue.environmentId) {
    return { success: false, message: "no_environment" };
  }

  const now = new Date();
  try {
    await db.insert(runs).values({
      projectId: issue.environmentId,
      userId: session.user.id,
      description:
        input.note?.trim() || (input.passed ? "Test passed" : "Test failed"),
      status: input.passed ? "success" : "failed",
      kind: "test",
      issueId: input.issueId,
      output: input.note?.trim() ?? "",
      runAt: now,
      completedAt: now,
    });
    revalidatePath("/projects", "layout");
    return { success: true };
  } catch (error) {
    console.error("Failed to record test run:", error);
    return { success: false, message: "Failed to record test run" };
  }
}
