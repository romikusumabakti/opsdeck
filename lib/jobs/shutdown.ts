// Graceful shutdown for the in-process BullMQ workers. Each worker registers
// its close function; one SIGTERM/SIGINT handler (installed on the first
// registration) drains them all before the process exits, so two workers never
// race each other to process.exit while the other still has jobs in flight.

const closers: Array<() => Promise<void>> = [];
let installed = false;

export function registerShutdown(close: () => Promise<void>): void {
  closers.push(close);
  if (installed) return;
  installed = true;
  const shutdown = async () => {
    const results = await Promise.allSettled(closers.map((c) => c()));
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Worker failed to close cleanly:", result.reason);
      }
    }
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
