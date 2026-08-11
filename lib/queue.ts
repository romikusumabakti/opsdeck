import { type ConnectionOptions, Queue } from "bullmq";
import IORedis from "ioredis";
import type { ServiceAction, ServiceRole } from "@/lib/services";

// The single BullMQ queue that carries every background operation. Job type is
// discriminated by the job *name* (a key of JobMap); the worker switches on it.
export const TASKS_QUEUE = "opsdeck-tasks";

// Job name → payload contract, shared by the enqueue side (server actions) and
// the worker. As with the old Inngest events, payloads carry only ids —
// credentials are re-loaded server-side in the worker so they never live in a
// Redis job record.
export type JobMap = {
  "db/backup.requested": {
    environmentId: string;
    compress?: boolean;
    database?: string;
    runId: string;
  };
  "db/restore.requested": {
    environmentId: string;
    filename: string;
    runId: string;
    restartBackend?: boolean;
    database?: string;
    // When set (and different from environmentId), the backup file is read from
    // this source environment's `dbBackupPath` instead of the target's. Only ever
    // an environment sharing the target's DB location (see dbLocationMatches), so
    // the target DB server reaches the source's backup dir without a file transfer.
    sourceEnvironmentId?: string;
  };
  "db/database.create.requested": {
    environmentId: string;
    database: string;
    runId: string;
  };
  "db/database.drop.requested": {
    environmentId: string;
    database: string;
    runId: string;
  };
  "db/database.rename.requested": {
    environmentId: string;
    from: string;
    to: string;
    runId: string;
  };
  "service/control.requested": {
    environmentId: string;
    role: ServiceRole;
    action: ServiceAction;
    runId: string;
  };
  "environment/mock-time.legacy": {
    environmentId: string;
    mockedAt: string;
    runId: string;
  };
  "environment/mock-time.reset-legacy": {
    environmentId: string;
    runId: string;
  };
  // --- Jira integration ---
  // Sweep one linked project. `full` ignores the stored cursor and re-reads the
  // whole remote project (the initial import, or a manual re-import).
  "jira/sync.project": {
    projectId: string;
    full?: boolean;
  };
  // A webhook told us one issue changed. Carries only ids — the handler
  // re-fetches from the API rather than trusting the delivered payload.
  "jira/issue.changed": {
    connectionId: string;
    jiraIssueId: string;
  };
  // Write an OpsDeck edit back. Names WHICH fields changed, never their values,
  // so a delayed retry pushes current state instead of a stale one.
  "jira/push.issue": {
    issueId: string;
    fields: ("title" | "description" | "status" | "priority" | "assignee")[];
  };
  "jira/push.comment": {
    commentId: string;
  };
};

export type JobName = keyof JobMap;

// BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection it
// uses for blocking commands (BRPOPLPUSH etc.), otherwise it throws on the
// first reconnect. One connection is shared by the Queue (producer) here; the
// worker builds its own.
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }
  return new IORedis(url, { maxRetriesPerRequest: null });
}

// Cache the connection + queue on globalThis so Next.js dev hot-reload (which
// re-evaluates this module) reuses one client instead of leaking a new Redis
// connection per reload.
const globalForQueue = globalThis as unknown as {
  __runsQueue?: Queue;
  __queueConnection?: IORedis;
};

function getQueue(): Queue {
  if (!globalForQueue.__runsQueue) {
    if (!globalForQueue.__queueConnection) {
      globalForQueue.__queueConnection = createRedisConnection();
    }
    const connection: ConnectionOptions = globalForQueue.__queueConnection;
    globalForQueue.__runsQueue = new Queue(TASKS_QUEUE, { connection });
  }
  return globalForQueue.__runsQueue;
}

// Per-job overrides on the defaults below. Kept to the three knobs that
// actually differ between job families rather than re-exporting BullMQ's whole
// options surface.
export type EnqueueOptions = {
  // Ops jobs stay at 1 (see below). Jira jobs are idempotent HTTP work and set
  // this higher so a 5xx or a network blip doesn't lose the update.
  attempts?: number;
  backoffMs?: number;
  // Collapses concurrent enqueues of the same logical work into one job (BullMQ
  // ignores an add whose id is already known). Used to keep two sweeps of one
  // project from racing each other.
  //
  // Note the retention interaction: BullMQ refuses a re-add while a job with
  // that id still EXISTS, including in the completed/failed retention lists. So
  // a job carrying an id is removed the moment it settles (see below) —
  // otherwise the second "Sync now" for a project would be silently dropped.
  jobId?: string;
};

// Enqueue a background job. `attempts: 1` by default — no auto-retry, matching
// the old Inngest `retries: 0`: every ops handler is side-effecting and marks
// its run `failed` on error, so a blind retry would re-run partial work.
// Completed jobs are pruned aggressively (run state lives in the Postgres
// `runs` table, not the Redis job record); failed jobs are kept longer for
// debugging.
export async function enqueue<N extends JobName>(
  name: N,
  data: JobMap[N],
  options: EnqueueOptions = {}
): Promise<void> {
  await getQueue().add(name, data, {
    attempts: options.attempts ?? 1,
    ...(options.backoffMs
      ? { backoff: { type: "exponential", delay: options.backoffMs } }
      : {}),
    ...(options.jobId
      ? {
          jobId: options.jobId,
          // Retention would keep the id alive and block the next enqueue of the
          // same work; these jobs record their outcome in Postgres, not Redis.
          removeOnComplete: true,
          removeOnFail: true,
        }
      : {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        }),
  });
}

// How often the reconcile sweep runs per linked project. Frequent enough that a
// missed webhook is corrected within a coffee break, sparse enough that a dozen
// linked projects don't hammer the Jira rate limit.
export const JIRA_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function jiraSchedulerId(projectId: string): string {
  return `jira-sweep-${projectId}`;
}

/**
 * Register the recurring Jira reconcile sweep for one linked project.
 *
 * The webhook is the fast path; this is the safety net that catches whatever it
 * dropped (delivery failure, app downtime, an edit made while the link was
 * disabled). `upsertJobScheduler` is keyed on the project, so re-registering
 * replaces the schedule instead of stacking a second one — which matters
 * because this is called on every link save AND on every worker boot.
 */
export async function scheduleJiraSweep(
  projectId: string,
  everyMs: number = JIRA_SWEEP_INTERVAL_MS
): Promise<void> {
  await getQueue().upsertJobScheduler(
    jiraSchedulerId(projectId),
    { every: everyMs },
    {
      name: "jira/sync.project",
      data: { projectId },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 50 },
      },
    }
  );
}

/** Stop sweeping a project (link disabled or removed). */
export async function unscheduleJiraSweep(projectId: string): Promise<void> {
  await getQueue().removeJobScheduler(jiraSchedulerId(projectId));
}
