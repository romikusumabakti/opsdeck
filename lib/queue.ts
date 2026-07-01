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
    projectId: string;
    compress?: boolean;
    database?: string;
    taskId: string;
  };
  "db/restore.requested": {
    projectId: string;
    filename: string;
    taskId: string;
    restartBackend?: boolean;
    database?: string;
  };
  "db/database.create.requested": {
    projectId: string;
    database: string;
    taskId: string;
  };
  "db/database.drop.requested": {
    projectId: string;
    database: string;
    taskId: string;
  };
  "db/database.rename.requested": {
    projectId: string;
    from: string;
    to: string;
    taskId: string;
  };
  "service/control.requested": {
    projectId: string;
    role: ServiceRole;
    action: ServiceAction;
    taskId: string;
  };
  "project/mock-time.legacy": {
    projectId: string;
    mockedAt: string;
    taskId: string;
  };
  "project/mock-time.reset-legacy": {
    projectId: string;
    taskId: string;
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
  __tasksQueue?: Queue;
  __queueConnection?: IORedis;
};

function getQueue(): Queue {
  if (!globalForQueue.__tasksQueue) {
    if (!globalForQueue.__queueConnection) {
      globalForQueue.__queueConnection = createRedisConnection();
    }
    const connection: ConnectionOptions = globalForQueue.__queueConnection;
    globalForQueue.__tasksQueue = new Queue(TASKS_QUEUE, { connection });
  }
  return globalForQueue.__tasksQueue;
}

// Enqueue a background job. `attempts: 1` — no auto-retry, matching the old
// Inngest `retries: 0`: every handler is side-effecting and marks its task
// `failed` on error, so a blind retry would re-run partial work. Completed
// jobs are pruned aggressively (task state lives in the Postgres `tasks`
// table, not the Redis job record); failed jobs are kept longer for debugging.
export async function enqueue<N extends JobName>(
  name: N,
  data: JobMap[N]
): Promise<void> {
  await getQueue().add(name, data, {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  });
}
