import { eq, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { type Issue, issues } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";

/** `db` itself or an open transaction (the insert then runs in a savepoint). */
export type IssueExecutor = Pick<typeof db, "transaction">;

/** The per-project counter: a lost race on it is retried with the next number. */
export const ISSUE_NUMBER_INDEX = "issues_project_number_idx";
/** One local issue per Jira issue: a violation means a mirror already exists. */
export const ISSUE_JIRA_ID_INDEX = "issues_jira_issue_id_idx";

const ATTEMPTS = 3;

/**
 * The index a unique violation hit, from the postgres-js error or the
 * DrizzleQueryError wrapping it; undefined when `error` is no unique violation
 * or names no constraint.
 */
export function uniqueViolationIndex(error: unknown): string | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const e = error as {
    constraint_name?: string;
    cause?: { constraint_name?: string };
  };
  return e.constraint_name ?? e.cause?.constraint_name;
}

/**
 * Insert an issue with the project's next per-project `number`: `max + 1`
 * inside a transaction, retried when a concurrent insert (a sweep, a person,
 * the assistant) took that number first. Any other unique violation (a Jira
 * mirror that already exists) is thrown to the caller. Called on an outer
 * transaction it runs as a savepoint, so a failed insert rolls back only
 * itself and the outer transaction carries on.
 */
export async function insertIssueWithNextNumber(
  executor: IssueExecutor,
  projectId: string,
  values: Omit<typeof issues.$inferInsert, "projectId" | "number">
): Promise<Issue> {
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
            .returning(),
          "issue"
        );
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const index = uniqueViolationIndex(error);
      // No constraint name (a driver that does not report it): treat it as
      // the counter, as before.
      if (index === undefined || index === ISSUE_NUMBER_INDEX) continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate an issue number in project ${projectId}`);
}
