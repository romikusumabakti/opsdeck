import { eq, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { issues } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";

/** `db` itself or an open transaction (the insert then runs in a savepoint). */
export type IssueExecutor = Pick<typeof db, "transaction">;

const ATTEMPTS = 3;

/**
 * Insert an issue with the project's next per-project `number`: `max + 1`
 * inside a transaction, retried on the unique violation when a concurrent
 * insert (a sweep, a person, the assistant) took that number first. Called on
 * an outer transaction it runs as a savepoint, so a lost race rolls back only
 * the insert and the outer transaction carries on.
 */
export async function insertIssueWithNextNumber(
  executor: IssueExecutor,
  projectId: string,
  values: Omit<typeof issues.$inferInsert, "projectId" | "number">
): Promise<{ id: string; number: number }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await executor.transaction(async (tx) => {
        const [highest] = await tx
          .select({ max: sql<number>`coalesce(max(${issues.number}), 0)` })
          .from(issues)
          .where(eq(issues.projectId, projectId));
        // A bare aggregate always yields one row and coalesce makes an empty
        // project 0, so the fallback is that same 0.
        const max = highest?.max ?? 0;
        return one(
          await tx
            .insert(issues)
            .values({ ...values, projectId, number: Number(max) + 1 })
            .returning({ id: issues.id, number: issues.number }),
          "issue"
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate an issue number in project ${projectId}`);
}
