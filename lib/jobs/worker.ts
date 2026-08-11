import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jiraProjectLinks } from "@/lib/db/schema";
import { processJob } from "@/lib/jobs/processor";
import {
  createRedisConnection,
  scheduleJiraSweep,
  TASKS_QUEUE,
} from "@/lib/queue";

// Concurrency cap. Handlers mostly wait on remote SSH/SQL round-trips, so a
// handful can run in parallel without straining the app container. The old
// Inngest setup ran functions concurrently across events; this preserves that
// without letting an unbounded burst of jobs open unbounded SSH sessions.
const WORKER_CONCURRENCY = 5;

// Cache the worker on globalThis so Next.js dev hot-reload (which re-runs the
// instrumentation register hook / re-imports this module) doesn't spawn a
// second Worker consuming the same queue.
const globalForWorker = globalThis as unknown as {
  __tasksWorker?: Worker;
};

// Starts the BullMQ worker that drains the runs queue. Idempotent: a second
// call returns the existing worker. No-op (returns null) when REDIS_URL is
// unset so the app still boots for local `next dev` without Redis — only the
// background operations are unavailable.
export function startWorker(): Worker | null {
  if (globalForWorker.__tasksWorker) return globalForWorker.__tasksWorker;
  if (!process.env.REDIS_URL) {
    console.warn("REDIS_URL not set — background job worker not started");
    return null;
  }

  const worker = new Worker(TASKS_QUEUE, processJob, {
    connection: createRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
  });

  // A job's own handler records run success/failure in Postgres; this is a
  // last-resort log for infrastructure-level failures (Redis hiccup, handler
  // throwing before it could write the run row).
  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.name} (${job?.id}) failed:`, err);
  });

  // Drain in-flight jobs on shutdown instead of leaving them stalled for the
  // stalled-job reaper. Registered once, alongside the single worker instance.
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Job schedulers live in Redis, so they normally survive a restart — but a
  // flushed Redis, a fresh deploy, or a link created while the worker was down
  // would leave a project unswept. Re-upserting every enabled link on boot is
  // idempotent (same scheduler key) and makes the DB the source of truth.
  restoreJiraSweeps().catch((error) => {
    console.error("Failed to restore Jira sweep schedules:", error);
  });

  globalForWorker.__tasksWorker = worker;
  return worker;
}

async function restoreJiraSweeps(): Promise<void> {
  const links = await db
    .select({ projectId: jiraProjectLinks.projectId })
    .from(jiraProjectLinks)
    .where(eq(jiraProjectLinks.enabled, true));
  for (const link of links) await scheduleJiraSweep(link.projectId);
}
