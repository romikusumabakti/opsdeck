// Next.js runs `register()` once per server process at startup. Two jobs:
//
//  1. Validate the environment and refuse to boot on a fatal misconfiguration,
//     rather than letting each consumer discover its own missing var whenever
//     it first happens to run (which for the background handlers means failing
//     inside a restore, not at deploy time).
//  2. Boot the in-process BullMQ worker that drains the background-task queue,
//     so the single app container both serves requests and processes jobs (no
//     separate worker service).
//
// Guarded to the Node.js runtime — the worker imports node-ssh and ioredis,
// which don't run on the Edge runtime, and `lib/env` is server-only.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/lib/env");
    validateEnv();

    const { startWorker } = await import("@/lib/jobs/worker");
    startWorker();
  }
}
