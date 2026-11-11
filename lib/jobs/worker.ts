import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jiraProjectLinks } from "@/lib/db/schema";
import { sweepExpiredLocks } from "@/lib/deploy/lock-release";
import { failStaleDeployments } from "@/lib/jobs/deploy";
import { processJob } from "@/lib/jobs/processor";
import { failStaleProvisionRuns } from "@/lib/provisioning/repository";
import {
  createRedisConnection,
  scheduleDeployLockSweep,
  scheduleEnvironmentArchivePrune,
  scheduleInstanceUpdateCheck,
  scheduleJiraSweep,
  TASKS_QUEUE,
} from "@/lib/queue";
import { failStaleTeardownRuns } from "@/lib/teardown/repository";

// Concurrency cap. Handlers mostly wait on remote SSH/SQL round-trips, so a
// handful can run in parallel without straining the app container. The old
// Inngest setup ran functions concurrently across events; this preserves that
// without letting an unbounded burst of jobs open unbounded SSH sessions.
const WORKER_CONCURRENCY = 5;

// One worker per process: a second caller gets the existing one instead of a
// second Worker consuming the same queue.
let tasksWorker: Worker | undefined;

// Starts the BullMQ worker that drains the runs queue. Idempotent: a second
// call returns the existing worker. No-op (returns null) when REDIS_URL is
// unset so the app still boots for local development without Redis — only the
// background operations are unavailable.
export function startWorker(): Worker | null {
  if (tasksWorker) return tasksWorker;
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

  // A deploy whose worker died mid-run stays `running` and blocks its
  // environment; fail the ones older than any live deploy can be.
  failStaleDeployments().catch((error) => {
    console.error("Failed to sweep stale deployments:", error);
  });

  // A provision run still `started` at boot lost its job with the old worker
  // (single worker); fail it so the environment can be provisioned again.
  failStaleProvisionRuns().catch((error) => {
    console.error("Failed to sweep stale provision runs:", error);
  });

  // Likewise a teardown run: fail it and its running steps (stepFailed), so
  // the teardown can be retried from the step it stopped at.
  failStaleTeardownRuns().catch((error) => {
    console.error("Failed to sweep stale teardown runs:", error);
  });

  // Expired deploy locks are released every 60 s by a repeatable job. Its
  // scheduler lives in Redis like the Jira ones, so re-register it on boot,
  // and release right away what expired while the worker was down.
  scheduleDeployLockSweep().catch((error) => {
    console.error("Failed to schedule the deploy lock sweep:", error);
  });
  sweepExpiredLocks().catch((error) => {
    console.error("Failed to sweep expired deploy locks:", error);
  });

  // The hourly release check (and auto-update); its scheduler lives in Redis.
  scheduleInstanceUpdateCheck().catch((error) => {
    console.error("Failed to schedule the instance update check:", error);
  });

  // The daily prune of deleted environments' archives; its scheduler lives
  // in Redis.
  scheduleEnvironmentArchivePrune().catch((error) => {
    console.error("Failed to schedule the environment archive prune:", error);
  });

  tasksWorker = worker;
  return worker;
}

async function restoreJiraSweeps(): Promise<void> {
  const links = await db
    .select({ projectId: jiraProjectLinks.projectId })
    .from(jiraProjectLinks)
    .where(eq(jiraProjectLinks.enabled, true));
  for (const link of links) await scheduleJiraSweep(link.projectId);
}
