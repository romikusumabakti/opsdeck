import { type NextRequest, NextResponse } from "next/server";
import { getRunningTasks } from "@/actions/tasks";
import { getServerSession } from "@/lib/auth-session";

// Streams the global running-tasks list as SSE. Same pattern as the per-task
// stream: server-side polls the DB, diff-suppresses, and pushes only on change.
// Replaces an 8s client poll — the server stays the only thing hitting the DB,
// and clients see updates within POLL_INTERVAL_MS instead of 8 s.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;
// Cap each SSE connection at 10 minutes; the EventSource on the client will
// auto-reconnect on close, which also lets us release file descriptors held
// by silently-departed tabs.
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
      };
      req.signal.addEventListener("abort", onAbort);

      function send(event: string, data: unknown) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          return false;
        }
      }

      try {
        let lastSerialized = "";
        while (!aborted) {
          if (Date.now() - startedAt > MAX_DURATION_MS) {
            send("timeout", { reason: "max-duration" });
            break;
          }

          let tasks: Awaited<ReturnType<typeof getRunningTasks>>;
          try {
            tasks = await getRunningTasks();
          } catch (err) {
            // Surface transient DB errors and stop, so the client backs off
            // instead of EventSource reconnecting straight into the same
            // failure. Generic message; real error logged server-side.
            console.error("running-tasks stream failed:", err);
            send("error", { message: "snapshot failed" });
            break;
          }
          const serialized = JSON.stringify(tasks);
          if (serialized !== lastSerialized) {
            if (!send("snapshot", tasks)) break;
            lastSerialized = serialized;
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed by abort
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
