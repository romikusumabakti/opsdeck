import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { registerShutdown } from "@/lib/jobs/shutdown";
import { createRedisConnection } from "@/lib/queue";
import { uuidSchema } from "@/lib/validation";
import { runTurn } from "./run-turn";
import { evictSnapshots } from "./snapshot";
import { failStaleAssistantMessages } from "./turn-store";

// Assistant turns run on their own queue and worker so a burst of long turns
// (minutes each) never occupies the deploy/ops worker's slots, and vice versa.
export const ASSISTANT_QUEUE = "menara-assistant";
export const ASSISTANT_TURN_JOB = "assistant/turn";
// Each turn streams one Claude conversation at a time; two in parallel keep
// the team from waiting on each other without multiplying API spend bursts.
const ASSISTANT_CONCURRENCY = 2;

export const assistantTurnPayloadSchema = z.object({ messageId: uuidSchema });
export type AssistantTurnPayload = z.infer<typeof assistantTurnPayloadSchema>;

let producer: Queue | undefined;

function getQueue(): Queue {
  producer ??= new Queue(ASSISTANT_QUEUE, {
    connection: createRedisConnection(),
  });
  return producer;
}

/**
 * Queue one turn. The job id is the message id, so a double submit cannot run
 * the same turn twice; no retries, because a retried turn would re-spend.
 * Outcomes live in Postgres, so settled jobs are removed from Redis.
 */
export async function enqueueAssistantTurn(messageId: string): Promise<void> {
  const data: AssistantTurnPayload = { messageId };
  await getQueue().add(ASSISTANT_TURN_JOB, data, {
    jobId: messageId,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Parses a job payload; throws (failing the job) on a malformed one. */
export function parseAssistantTurnPayload(data: unknown): AssistantTurnPayload {
  const parsed = assistantTurnPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid payload for job "${ASSISTANT_TURN_JOB}" — ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

let assistantWorker: Worker | undefined;

/**
 * Starts the assistant worker. Idempotent; no-op (null) without REDIS_URL.
 * On boot it fails turns orphaned by the previous process and evicts old
 * source snapshots; both only log on error.
 */
export function startAssistantWorker(): Worker | null {
  if (assistantWorker) return assistantWorker;
  if (!process.env.REDIS_URL) {
    console.warn("REDIS_URL not set — assistant worker not started");
    return null;
  }

  const worker = new Worker(
    ASSISTANT_QUEUE,
    async (job) => {
      const { messageId } = parseAssistantTurnPayload(job.data);
      await runTurn(messageId);
    },
    {
      connection: createRedisConnection(),
      concurrency: ASSISTANT_CONCURRENCY,
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`Assistant job ${job?.id} failed:`, err);
  });
  registerShutdown(() => worker.close());

  failStaleAssistantMessages()
    .then((count) => {
      if (count > 0) console.warn(`[assistant] failed ${count} stale turns`);
    })
    .catch((error) => {
      console.error("Failed to sweep stale assistant messages:", error);
    });
  evictSnapshots().catch((error) => {
    console.error("Failed to evict assistant snapshots:", error);
  });

  assistantWorker = worker;
  return worker;
}
