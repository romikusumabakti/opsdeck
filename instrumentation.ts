// Next.js runs `register()` once per server process at startup. We use it to
// boot the in-process BullMQ worker that drains the background-task queue, so
// the single app container both serves requests and processes jobs (no separate
// worker service). Guarded to the Node.js runtime — the worker imports node-ssh
// and ioredis, which don't run on the Edge runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/lib/jobs/worker");
    startWorker();
  }
}
