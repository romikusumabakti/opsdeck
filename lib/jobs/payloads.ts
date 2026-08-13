import { z } from "zod";
import type { JobMap, JobName } from "@/lib/queue";
import {
  backupFilenameSchema,
  databaseNameSchema,
  isoDateTimeSchema,
  serviceActionSchema,
  serviceRoleSchema,
  uuidSchema,
} from "@/lib/validation";

/**
 * Runtime contracts for what the worker is allowed to act on.
 *
 * The enqueue side already validates its inputs (see actions/databases.ts,
 * actions/backups.ts), so this is not the first check — it is the check at the
 * point where the values become shell and SQL. That matters because a BullMQ
 * job is not a function call: it sits in Redis, which survives a deploy. A job
 * written by the previous release, or hand-inserted, or replayed from a
 * retained failure, reaches these handlers with whatever shape it had — and the
 * handlers feed `database`, `filename` and `from`/`to` straight into
 * `DROP DATABASE`, `psql <` and `ALTER DATABASE ... MODIFY NAME`.
 *
 * The map is typed `{ [N in JobName]: z.ZodType<JobMap[N]> }`, so adding a job
 * to `JobMap` without a schema — or writing one whose output doesn't match the
 * declared payload — is a compile error, not a gap discovered at 3am.
 */

// Backup/restore may carry the environment's OWN configured `dbName`, which is
// operator-entered config rather than client input and is not held to
// `databaseNameSchema` anywhere else. Tightening it here would break existing
// environments whose database name predates that rule, so bound the length and
// leave the strict identifier check to the create/drop/rename jobs, where the
// value is always client-supplied and already validated at enqueue time.
const configuredDatabaseNameSchema = z.string().min(1).max(255);

const JOB_PAYLOAD_SCHEMAS: { [N in JobName]: z.ZodType<JobMap[N]> } = {
  "db/backup.requested": z.object({
    environmentId: uuidSchema,
    compress: z.boolean().optional(),
    database: configuredDatabaseNameSchema.optional(),
    runId: uuidSchema,
  }),
  "db/restore.requested": z.object({
    environmentId: uuidSchema,
    filename: backupFilenameSchema,
    runId: uuidSchema,
    restartBackend: z.boolean().optional(),
    // Only ever set for a NON-default target, which the action validates with
    // databaseNameSchema before enqueueing — so the strict rule applies here.
    database: databaseNameSchema.optional(),
    sourceEnvironmentId: uuidSchema.optional(),
  }),
  "db/database.create.requested": z.object({
    environmentId: uuidSchema,
    database: databaseNameSchema,
    runId: uuidSchema,
  }),
  "db/database.drop.requested": z.object({
    environmentId: uuidSchema,
    database: databaseNameSchema,
    runId: uuidSchema,
  }),
  "db/database.rename.requested": z.object({
    environmentId: uuidSchema,
    from: databaseNameSchema,
    to: databaseNameSchema,
    runId: uuidSchema,
  }),
  "service/control.requested": z.object({
    environmentId: uuidSchema,
    role: serviceRoleSchema,
    action: serviceActionSchema,
    runId: uuidSchema,
  }),
  "environment/mock-time.legacy": z.object({
    environmentId: uuidSchema,
    mockedAt: isoDateTimeSchema,
    runId: uuidSchema,
  }),
  "environment/mock-time.reset-legacy": z.object({
    environmentId: uuidSchema,
    runId: uuidSchema,
  }),
  "jira/sync.project": z.object({
    projectId: uuidSchema,
    full: z.boolean().optional(),
  }),
  "jira/issue.changed": z.object({
    connectionId: uuidSchema,
    jiraIssueId: z.string().min(1).max(64),
  }),
  "jira/push.issue": z.object({
    issueId: uuidSchema,
    fields: z.array(
      z.enum(["title", "description", "status", "priority", "assignee"])
    ),
  }),
  "jira/push.comment": z.object({
    commentId: uuidSchema,
  }),
};

/**
 * Parse a job's data against its declared payload contract.
 *
 * Throws on mismatch, which BullMQ records as a failed job — the right outcome
 * for a payload nobody can safely act on. Unknown keys are stripped rather than
 * rejected so an older producer that carried an extra field still runs.
 */
export function parseJobPayload<N extends JobName>(
  name: N,
  data: unknown
): JobMap[N] {
  const parsed = JOB_PAYLOAD_SCHEMAS[name].safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new Error(`Invalid payload for job "${name}" — ${detail}`);
  }
  return parsed.data;
}
